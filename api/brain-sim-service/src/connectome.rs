//! Load connectome from file at startup; compute neuron_ids, connections, sensory/motor indices.
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const SUGAR_GRN_IDS: [&str; 21] = [
    "720575940624963786", "720575940630233916", "720575940637568838", "720575940638202345",
    "720575940617000768", "720575940630797113", "720575940632889389", "720575940621754367",
    "720575940621502051", "720575940640649691", "720575940639332736", "720575940616885538",
    "720575940639198653", "720575940639259967", "720575940617937543", "720575940632425919",
    "720575940633143833", "720575940612670570", "720575940628853239", "720575940629176663",
    "720575940611875570",
];

fn is_photoreceptor(cell_type: Option<&str>) -> bool {
    let s = match cell_type {
        Some(x) if !x.trim().is_empty() => x.trim(),
        _ => return false,
    };
    s.len() >= 2
        && s.chars().next().map(|c| c == 'R' || c == 'r') == Some(true)
        && s.chars().nth(1).map(|c| c.is_ascii_digit()) == Some(true)
}

#[derive(Deserialize)]
struct NeuronJson {
    root_id: String,
    role: Option<String>,
    cell_type: Option<String>,
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
    let mut afferent_visual = Vec::new();
    let mut sugar_grn = Vec::new();
    let mut motor_left = Vec::new();
    let mut motor_right = Vec::new();
    let mut motor_unknown = Vec::new();

    for (i, n) in data.neurons.iter().enumerate() {
        let role = n.role.as_deref().unwrap_or("interneuron");
        if SUGAR_GRN_IDS.contains(&n.root_id.as_str()) {
            sugar_grn.push(i as u32);
        }
        match role {
            "sensory" => {
                sensory.push(i as u32);
                if is_photoreceptor(n.cell_type.as_deref()) {
                    afferent_visual.push(i as u32);
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

    let sensory_target = if sugar_grn.is_empty() {
        if afferent_visual.is_empty() {
            sensory
        } else {
            afferent_visual
        }
    } else {
        sugar_grn
    };
    let sensory_target_set: std::collections::HashSet<u32> = sensory_target.iter().copied().collect();
    let mut sensory_left_indices: Vec<u32> = Vec::new();
    let mut sensory_right_indices: Vec<u32> = Vec::new();
    let mut sensory_unknown_indices: Vec<u32> = Vec::new();
    for (i, n) in data.neurons.iter().enumerate() {
        let idx = i as u32;
        if !sensory_target_set.contains(&idx) {
            continue;
        }
        match n.side.as_deref() {
            Some("left") => sensory_left_indices.push(idx),
            Some("right") => sensory_right_indices.push(idx),
            _ => sensory_unknown_indices.push(idx),
        }
    }

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
