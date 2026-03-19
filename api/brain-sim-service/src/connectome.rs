//! Load connectome from file at startup; compute neuron_ids, connections, sensory/motor indices.
//!
//! **Full connectome:** We load ALL connections in the file. There is no filtering by neuron type,
//! region, or edge count. The connectome file (parquet or JSON) must contain the complete
//! fly-brain graph (e.g. FlyWire / full fly brain) so that every synapse is simulated.
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::fs;
use std::path::Path;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::Field;

#[derive(Deserialize)]
struct LateralizedIdsJson {
    left: Vec<String>,
    right: Vec<String>,
    unknown: Vec<String>,
}

struct PrecomputedIndices {
    left: Vec<u32>,
    right: Vec<u32>,
    unknown: Vec<u32>,
    total_left: usize,
    total_right: usize,
    total_unknown: usize,
}

#[derive(Deserialize)]
struct NeuronJson {
    root_id: String,
    role: Option<String>,
    side: Option<String>,
}

#[derive(Deserialize)]
struct ConnectionJson {
    pre: String,
    post: String,
    weight: Option<f64>,
}

#[derive(Deserialize)]
struct ConnectomeJson {
    neurons: Vec<NeuronJson>,
    connections: Vec<ConnectionJson>,
}

#[derive(Deserialize)]
struct EpgTileMapEntryJson {
    root_id: String,
}

#[derive(Deserialize)]
struct EpgTileMapJson {
    entries: Vec<EpgTileMapEntryJson>,
}

struct ParsedConnectome {
    neuron_ids: Vec<String>,
    neuron_meta: HashMap<String, (Option<String>, Option<String>)>,
    connections: Vec<(String, String, Option<f64>)>,
}

pub struct ConnectomeTemplate {
    pub neuron_ids: Vec<String>,
    /// id -> index for fast lookup (forced spikes, activity).
    pub neuron_index_by_id: HashMap<String, usize>,
    pub viewer_subset_indices: Vec<u32>,
    /// is_epg[i] = 1 if neuron i is in viewer subset (used for recurrence boost).
    pub is_epg: Vec<u8>,
    pub edges_pre: Vec<u32>,
    pub edges_post: Vec<u32>,
    pub edges_weight: Vec<f32>,
    /// CSR by pre: out_offsets[pre]..out_offsets[pre+1] indexes into out_post/out_weight for spike-driven recurrent.
    pub out_offsets: Vec<u32>,
    pub out_post: Vec<u32>,
    pub out_weight: Vec<f32>,
    pub sensory_indices: Vec<u32>,
    pub sensory_left_indices: Vec<u32>,
    pub sensory_right_indices: Vec<u32>,
    pub sensory_unknown_indices: Vec<u32>,
    pub motor_left: Vec<u32>,
    pub motor_right: Vec<u32>,
    pub motor_unknown: Vec<u32>,
}

fn viewer_subset_limit() -> usize {
    std::env::var("NEUROSIM_VIEWER_NEURON_LIMIT")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(10_000)
        .max(1)
}

fn fnv1a32(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

fn compute_viewer_subset_indices(neuron_ids: &[String], limit: usize) -> Vec<u32> {
    if neuron_ids.is_empty() {
        return Vec::new();
    }
    if neuron_ids.len() <= limit {
        return (0..neuron_ids.len() as u32).collect();
    }
    let mut ranked: Vec<(u32, u32)> = neuron_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (fnv1a32(id), i as u32))
        .collect();
    ranked.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut out: Vec<u32> = ranked.into_iter().take(limit).map(|(_, idx)| idx).collect();
    out.sort_unstable();
    out
}

fn load_epg_viewer_indices(
    connectome_path: &Path,
    id_to_idx: &HashMap<String, u32>,
) -> Option<Vec<u32>> {
    let mut candidates = Vec::new();
    if let Some(parent) = connectome_path.parent() {
        candidates.push(parent.join("epg-tile-map.json"));
        if let Some(grandparent) = parent.parent() {
            candidates.push(grandparent.join("epg-tile-map.json"));
            candidates.push(grandparent.join("data").join("epg-tile-map.json"));
        }
    }
    if let Some(repo_root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(|p| p.parent()) {
        candidates.push(repo_root.join("data").join("epg-tile-map.json"));
    }
    let epg_map_path = candidates.into_iter().find(|p| p.exists())?;
    let txt = fs::read_to_string(epg_map_path).ok()?;
    let parsed: EpgTileMapJson = serde_json::from_str(&txt).ok()?;
    let mut out: Vec<u32> = parsed
        .entries
        .iter()
        .filter_map(|e| id_to_idx.get(&e.root_id).copied())
        .collect();
    out.sort_unstable();
    out.dedup();
    Some(out)
}

fn load_precomputed_indices(
    connectome_path: &Path,
    id_to_idx: &HashMap<String, u32>,
    filename: &str,
) -> Option<PrecomputedIndices> {
    let mut candidates = Vec::new();
    if let Some(parent) = connectome_path.parent() {
        candidates.push(parent.join(filename));
        if let Some(grandparent) = parent.parent() {
            candidates.push(grandparent.join(filename));
            candidates.push(grandparent.join("data").join(filename));
        }
    }
    if let Some(repo_root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(|p| p.parent()) {
        candidates.push(repo_root.join("data").join(filename));
    }
    let precomputed_path = candidates.into_iter().find(|p| p.exists())?;
    let txt = fs::read_to_string(precomputed_path).ok()?;
    let parsed: LateralizedIdsJson = serde_json::from_str(&txt).ok()?;
    let total_left = parsed.left.len();
    let total_right = parsed.right.len();
    let total_unknown = parsed.unknown.len();
    let mut left: Vec<u32> = parsed
        .left
        .iter()
        .filter_map(|id| id_to_idx.get(id).copied())
        .collect();
    let mut right: Vec<u32> = parsed
        .right
        .iter()
        .filter_map(|id| id_to_idx.get(id).copied())
        .collect();
    let mut unknown: Vec<u32> = parsed
        .unknown
        .iter()
        .filter_map(|id| id_to_idx.get(id).copied())
        .collect();
    left.sort_unstable();
    right.sort_unstable();
    unknown.sort_unstable();
    Some(PrecomputedIndices {
        left,
        right,
        unknown,
        total_left,
        total_right,
        total_unknown,
    })
}

fn load_precomputed_olfactory_indices(
    connectome_path: &Path,
    id_to_idx: &HashMap<String, u32>,
) -> Option<PrecomputedIndices> {
    load_precomputed_indices(connectome_path, id_to_idx, "olfactory-afferents.json")
}

pub fn load_connectome(path: &Path) -> Result<ConnectomeTemplate, Box<dyn std::error::Error + Send + Sync>> {
    let parsed = load_connectome_data(path)?;
    build_template(path, parsed)
}

fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn field_to_id(field: &Field) -> Option<String> {
    match field {
        Field::Str(v) => {
            let s = v.trim();
            if s.is_empty() { None } else { Some(s.to_string()) }
        }
        Field::Int(v) => Some(v.to_string()),
        Field::Long(v) => Some(v.to_string()),
        Field::UInt(v) => Some(v.to_string()),
        Field::ULong(v) => Some(v.to_string()),
        Field::Byte(v) => Some(v.to_string()),
        Field::Short(v) => Some(v.to_string()),
        Field::UByte(v) => Some(v.to_string()),
        Field::UShort(v) => Some(v.to_string()),
        _ => None,
    }
}

fn field_to_weight(field: &Field) -> Option<f64> {
    match field {
        Field::Float(v) => Some(*v as f64),
        Field::Double(v) => Some(*v),
        Field::Int(v) => Some(*v as f64),
        Field::Long(v) => Some(*v as f64),
        Field::UInt(v) => Some(*v as f64),
        Field::ULong(v) => Some(*v as f64),
        Field::Byte(v) => Some(*v as f64),
        Field::Short(v) => Some(*v as f64),
        Field::UByte(v) => Some(*v as f64),
        Field::UShort(v) => Some(*v as f64),
        _ => None,
    }
}

fn pick_column<'a>(names: &'a [String], candidates: &[&str]) -> Option<&'a String> {
    // Candidate priority matters (e.g. prefer "Excitatory x Connectivity" over "Connectivity").
    for cand in candidates {
        let cand_norm = normalize_name(cand);
        if let Some(found) = names.iter().find(|name| normalize_name(name) == cand_norm) {
            return Some(found);
        }
    }
    None
}

fn load_connectome_data(path: &Path) -> Result<ParsedConnectome, Box<dyn std::error::Error + Send + Sync>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "json" => load_connectome_json(path),
        "parquet" => load_connectome_parquet(path),
        _ => Err(format!(
            "unsupported connectome extension '{}' for {} (expected .json or .parquet)",
            ext,
            path.display()
        )
        .into()),
    }
}

fn load_connectome_json(path: &Path) -> Result<ParsedConnectome, Box<dyn std::error::Error + Send + Sync>> {
    let s = fs::read_to_string(path)?;
    let data: ConnectomeJson = serde_json::from_str(&s)?;
    if data.neurons.is_empty() || data.connections.is_empty() {
        return Err("connectome has no neurons or connections".into());
    }
    let neuron_ids: Vec<String> = data.neurons.iter().map(|n| n.root_id.clone()).collect();
    let mut neuron_meta = HashMap::with_capacity(data.neurons.len());
    for n in data.neurons {
        neuron_meta.insert(n.root_id, (n.role, n.side));
    }
    let connections = data
        .connections
        .into_iter()
        .map(|c| (c.pre, c.post, c.weight))
        .collect();
    Ok(ParsedConnectome {
        neuron_ids,
        neuron_meta,
        connections,
    })
}

fn load_connectome_parquet(path: &Path) -> Result<ParsedConnectome, Box<dyn std::error::Error + Send + Sync>> {
    let file = File::open(path)?;
    let reader = SerializedFileReader::new(file)?;
    let schema = reader.metadata().file_metadata().schema_descr();
    let names: Vec<String> = schema.columns().iter().map(|c| c.path().string()).collect();
    let pre_name = pick_column(
        &names,
        &["pre_root_id", "pre", "source", "from", "Presynaptic_ID", "presynaptic_id"],
    )
        .ok_or("parquet is missing pre neuron column (tried pre_root_id/pre/source/from/Presynaptic_ID)")?
        .clone();
    let post_name = pick_column(
        &names,
        &["post_root_id", "post", "target", "to", "Postsynaptic_ID", "postsynaptic_id"],
    )
        .ok_or("parquet is missing post neuron column (tried post_root_id/post/target/to/Postsynaptic_ID)")?
        .clone();
    let weight_name = pick_column(
        &names,
        &[
            "Excitatory x Connectivity",
            "weight",
            "syn_count",
            "synapse_count",
            "Connectivity",
            "count",
        ],
    )
    .cloned();

    let mut ids = Vec::<String>::new();
    let mut seen = HashMap::<String, ()>::new();
    let mut connections = Vec::<(String, String, Option<f64>)>::new();
    // Load every row (full connectome; no edge filtering).
    let mut iter = reader.get_row_iter(None)?;
    while let Some(row) = iter.next() {
        let row = row?;
        let mut pre: Option<String> = None;
        let mut post: Option<String> = None;
        let mut weight: Option<f64> = None;
        for (name, field) in row.get_column_iter() {
            if name == &pre_name {
                pre = field_to_id(field);
            } else if name == &post_name {
                post = field_to_id(field);
            } else if weight_name.as_deref() == Some(name) {
                weight = field_to_weight(field);
            }
        }
        let (Some(pre_id), Some(post_id)) = (pre, post) else {
            continue;
        };
        if !seen.contains_key(&pre_id) {
            seen.insert(pre_id.clone(), ());
            ids.push(pre_id.clone());
        }
        if !seen.contains_key(&post_id) {
            seen.insert(post_id.clone(), ());
            ids.push(post_id.clone());
        }
        connections.push((pre_id, post_id, weight));
    }

    if ids.is_empty() || connections.is_empty() {
        return Err("parquet connectome has no usable neuron IDs or connections".into());
    }

    eprintln!(
        "[connectome] parquet columns pre='{}' post='{}' weight='{}' rows={} neurons={}",
        pre_name,
        post_name,
        weight_name.as_deref().unwrap_or("<none>"),
        connections.len(),
        ids.len()
    );

    Ok(ParsedConnectome {
        neuron_ids: ids,
        neuron_meta: HashMap::new(),
        connections,
    })
}

fn build_template(
    path: &Path,
    data: ParsedConnectome,
) -> Result<ConnectomeTemplate, Box<dyn std::error::Error + Send + Sync>> {
    let neuron_ids = data.neuron_ids;
    let id_to_idx: HashMap<String, u32> = neuron_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), i as u32))
        .collect();

    let mut sensory = Vec::new();
    let mut sensory_left_all = Vec::new();
    let mut sensory_right_all = Vec::new();
    let mut sensory_unknown_all = Vec::new();
    let mut motor_left = Vec::new();
    let mut motor_right = Vec::new();
    let mut motor_unknown = Vec::new();

    for (i, root_id) in neuron_ids.iter().enumerate() {
        let (role, side) = data
            .neuron_meta
            .get(root_id)
            .cloned()
            .unwrap_or((None, None));
        let role = role.as_deref().unwrap_or("interneuron");
        match role {
            "sensory" => {
                sensory.push(i as u32);
                match side.as_deref() {
                    Some("left") => sensory_left_all.push(i as u32),
                    Some("right") => sensory_right_all.push(i as u32),
                    _ => sensory_unknown_all.push(i as u32),
                }
            }
            "motor" => {
                match side.as_deref().unwrap_or("unknown") {
                    "left" => motor_left.push(i as u32),
                    "right" => motor_right.push(i as u32),
                    _ => motor_unknown.push(i as u32),
                }
            }
            _ => {}
        }
    }

    let (sensory_left_indices, sensory_right_indices, sensory_unknown_indices) =
        if let Some(olf) =
            load_precomputed_olfactory_indices(path, &id_to_idx)
        {
            eprintln!(
                "[connectome] olfactory precomputed total(L/R/U)={}/{}/{} overlap_in_loaded_connectome(L/R/U)={}/{}/{}",
                olf.total_left, olf.total_right, olf.total_unknown, olf.left.len(), olf.right.len(), olf.unknown.len()
            );
            if !olf.left.is_empty() || !olf.right.is_empty() || !olf.unknown.is_empty() {
                (olf.left, olf.right, olf.unknown)
            } else {
                eprintln!(
                    "[connectome] zero overlap with precomputed olfactory IDs; using all sensory neurons in loaded connectome"
                );
                (sensory_left_all, sensory_right_all, sensory_unknown_all)
            }
        } else {
            eprintln!(
                "[connectome] missing/invalid data/olfactory-afferents.json; using all sensory neurons in loaded connectome"
            );
            (sensory_left_all, sensory_right_all, sensory_unknown_all)
        };
    let mut sensory_target = Vec::with_capacity(
        sensory_left_indices.len() + sensory_right_indices.len() + sensory_unknown_indices.len(),
    );
    sensory_target.extend_from_slice(&sensory_left_indices);
    sensory_target.extend_from_slice(&sensory_right_indices);
    sensory_target.extend_from_slice(&sensory_unknown_indices);
    sensory_target.sort_unstable();
    sensory_target.dedup();

    let loaded_epg_indices = load_epg_viewer_indices(path, &id_to_idx).filter(|v| !v.is_empty());
    let viewer_subset_indices = match loaded_epg_indices.as_ref() {
        Some(v) => v.clone(),
        None => compute_viewer_subset_indices(&neuron_ids, viewer_subset_limit()),
    };
    let mut edges_pre = Vec::with_capacity(data.connections.len());
    let mut edges_post = Vec::with_capacity(data.connections.len());
    let mut edges_weight = Vec::with_capacity(data.connections.len());
    // Include every connection (full connectome). Only skip invalid weight (non-finite or zero).
    // Store raw synapse count from connectome (Excitatory x Connectivity); W_SYN applied in sim step.
    for (pre_id, post_id, w_opt) in &data.connections {
        if let (Some(&pre), Some(&post)) = (id_to_idx.get(pre_id), id_to_idx.get(post_id)) {
            let count = w_opt.unwrap_or(1.0);
            // Keep signed weights (inhibitory edges are negative in Excitatory x Connectivity).
            if !count.is_finite() || count == 0.0 {
                continue;
            }
            edges_pre.push(pre);
            edges_post.push(post);
            edges_weight.push(count as f32);
        }
    }

    let n = neuron_ids.len();
    let num_edges = edges_pre.len();
    // Build CSR by pre for spike-driven recurrent: only iterate edges from spiking neurons.
    let mut out_degree: Vec<u32> = vec![0; n];
    for &pre in &edges_pre {
        if (pre as usize) < n {
            out_degree[pre as usize] += 1;
        }
    }
    let mut out_offsets: Vec<u32> = vec![0; n + 1];
    for i in 0..n {
        out_offsets[i + 1] = out_offsets[i] + out_degree[i];
    }
    let mut next_index = out_offsets.clone();
    let mut out_post: Vec<u32> = vec![0; num_edges];
    let mut out_weight: Vec<f32> = vec![0.0; num_edges];
    for e in 0..num_edges {
        let pre = edges_pre[e] as usize;
        if pre < n {
            let pos = next_index[pre] as usize;
            next_index[pre] += 1;
            out_post[pos] = edges_post[e];
            out_weight[pos] = edges_weight[e];
        }
    }

    let pre_motor_left = motor_left;
    let pre_motor_right = motor_right;
    let pre_motor_unknown = motor_unknown;

    let neuron_index_by_id: HashMap<String, usize> = neuron_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), i))
        .collect();
    let mut is_epg = vec![0u8; n];
    if let Some(epg_indices) = loaded_epg_indices {
        for &idx in &epg_indices {
            let i = idx as usize;
            if i < n {
                is_epg[i] = 1;
            }
        }
    }

    Ok(ConnectomeTemplate {
        neuron_ids,
        neuron_index_by_id,
        viewer_subset_indices,
        is_epg,
        edges_pre,
        edges_post,
        edges_weight,
        out_offsets,
        out_post,
        out_weight,
        sensory_indices: sensory_target,
        sensory_left_indices,
        sensory_right_indices,
        sensory_unknown_indices,
        motor_left: pre_motor_left,
        motor_right: pre_motor_right,
        motor_unknown: pre_motor_unknown,
    })
}
