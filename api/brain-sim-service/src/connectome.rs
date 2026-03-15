//! Load connectome from file at startup; compute neuron_ids, connections, sensory/motor indices.
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
struct OlfactoryAfferentsJson {
    left: Vec<String>,
    right: Vec<String>,
    unknown: Vec<String>,
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

pub struct ConnectomeTemplate {
    pub neuron_ids: Vec<String>,
    pub viewer_subset_indices: Vec<u32>,
    pub edges_pre: Vec<u32>,
    pub edges_post: Vec<u32>,
    pub edges_weight: Vec<f32>,
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

fn load_precomputed_olfactory_indices(
    connectome_path: &Path,
    id_to_idx: &HashMap<String, u32>,
) -> Option<(Vec<u32>, Vec<u32>, Vec<u32>, usize, usize, usize)> {
    let precomputed_path = connectome_path.parent()?.join("olfactory-afferents.json");
    let txt = fs::read_to_string(precomputed_path).ok()?;
    let parsed: OlfactoryAfferentsJson = serde_json::from_str(&txt).ok()?;
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
    Some((left, right, unknown, total_left, total_right, total_unknown))
}

pub fn load_connectome(path: &Path) -> Result<ConnectomeTemplate, Box<dyn std::error::Error + Send + Sync>> {
    let s = fs::read_to_string(path)?;
    let data: ConnectomeJson = serde_json::from_str(&s)?;
    if data.neurons.is_empty() || data.connections.is_empty() {
        return Err("connectome has no neurons or connections".into());
    }

    let neuron_ids: Vec<String> = data.neurons.iter().map(|n| n.root_id.clone()).collect();
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

    for (i, n) in data.neurons.iter().enumerate() {
        let role = n.role.as_deref().unwrap_or("interneuron");
        match role {
            "sensory" => {
                sensory.push(i as u32);
                match n.side.as_deref() {
                    Some("left") => sensory_left_all.push(i as u32),
                    Some("right") => sensory_right_all.push(i as u32),
                    _ => sensory_unknown_all.push(i as u32),
                }
            }
            "motor" => {
                let side = n.side.as_deref().unwrap_or("unknown");
                match side {
                    "left" => motor_left.push(i as u32),
                    "right" => motor_right.push(i as u32),
                    _ => motor_unknown.push(i as u32),
                }
            }
            _ => {}
        }
    }

    // Prefer precomputed olfactory afferents from data/olfactory-afferents.json.
    // If overlap with the currently loaded connectome is empty, fall back to all sensory neurons.
    let (sensory_left_indices, sensory_right_indices, sensory_unknown_indices) =
        if let Some((olf_l, olf_r, olf_u, total_l, total_r, total_u)) =
            load_precomputed_olfactory_indices(path, &id_to_idx)
        {
            eprintln!(
                "[connectome] olfactory precomputed total(L/R/U)={}/{}/{} overlap_in_loaded_connectome(L/R/U)={}/{}/{}",
                total_l, total_r, total_u, olf_l.len(), olf_r.len(), olf_u.len()
            );
            if !olf_l.is_empty() || !olf_r.is_empty() || !olf_u.is_empty() {
                (olf_l, olf_r, olf_u)
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

    let viewer_subset_indices = compute_viewer_subset_indices(&neuron_ids, viewer_subset_limit());
    let mut edges_pre = Vec::with_capacity(data.connections.len());
    let mut edges_post = Vec::with_capacity(data.connections.len());
    let mut edges_weight = Vec::with_capacity(data.connections.len());
    for c in &data.connections {
        if let (Some(&pre), Some(&post)) = (id_to_idx.get(&c.pre), id_to_idx.get(&c.post)) {
            let w = c.weight.unwrap_or(1.0);
            let wf = if w.is_finite() && w > 0.0 { w as f32 } else { 1.0 };
            edges_pre.push(pre);
            edges_post.push(post);
            edges_weight.push(wf.min(10.0));
        }
    }

    Ok(ConnectomeTemplate {
        neuron_ids,
        viewer_subset_indices,
        edges_pre,
        edges_post,
        edges_weight,
        sensory_indices: sensory_target,
        sensory_left_indices,
        sensory_right_indices,
        sensory_unknown_indices,
        motor_left,
        motor_right,
        motor_unknown,
    })
}
