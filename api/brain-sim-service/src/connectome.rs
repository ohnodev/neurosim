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
    pub connections: Vec<(String, String, f64)>,
    pub sensory_indices: Vec<u32>,
    pub motor_left: Vec<u32>,
    pub motor_right: Vec<u32>,
    pub motor_unknown: Vec<u32>,
}

pub fn load_connectome(path: &Path) -> Result<ConnectomeTemplate, Box<dyn std::error::Error + Send + Sync>> {
    let s = fs::read_to_string(path)?;
    let data: ConnectomeJson = serde_json::from_str(&s)?;
    if data.neurons.is_empty() || data.connections.is_empty() {
        return Err("connectome has no neurons or connections".into());
    }

    let neuron_ids: Vec<String> = data.neurons.iter().map(|n| n.root_id.clone()).collect();
    let _id_to_idx: HashMap<String, u32> = neuron_ids
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

    let connections: Vec<(String, String, f64)> = data
        .connections
        .iter()
        .map(|c| (c.pre.clone(), c.post.clone(), c.weight.unwrap_or(1.0)))
        .collect();

    Ok(ConnectomeTemplate {
        neuron_ids,
        connections,
        sensory_indices: sensory_target,
        motor_left,
        motor_right,
        motor_unknown,
    })
}
