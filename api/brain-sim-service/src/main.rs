//! Brain sim service - Unix socket server.
use brain_sim_service::sim::{BrainSim, FlyInput, PendingStimInput, SourceInput};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Mutex;

fn main() {
    let socket_path = std::env::var("NEUROSIM_BRAIN_SOCKET")
        .unwrap_or_else(|_| "/tmp/neurosim-brain.sock".to_string());
    if Path::new(&socket_path).exists() {
        let _ = std::fs::remove_file(&socket_path);
    }
    let listener = UnixListener::bind(&socket_path).expect("bind socket");
    eprintln!("[brain-service] listening on {}", socket_path);

    let sims: Mutex<HashMap<u32, BrainSim>> = Mutex::new(HashMap::new());
    let next_id: Mutex<u32> = Mutex::new(0);

    for stream in listener.incoming() {
        if let Ok(mut s) = stream {
            let _ = handle(&mut s, &sims, &next_id);
        }
    }
}

#[derive(Deserialize)]
struct CreateParams {
    neuron_ids: Vec<String>,
    connections: Vec<Conn>,
    sensory_indices: Vec<u32>,
    motor_left: Vec<u32>,
    motor_right: Vec<u32>,
    motor_unknown: Vec<u32>,
}

#[derive(Deserialize)]
struct Conn {
    pre: String,
    post: String,
    weight: Option<f64>,
}

#[derive(Deserialize)]
struct StepParams {
    sim_id: u32,
    dt: f64,
    fly: FlyJson,
    sources: Vec<SourceJson>,
    pending: Vec<PendingJson>,
}

#[derive(Deserialize)]
struct FlyJson {
    x: f64,
    y: f64,
    z: f64,
    heading: f64,
    t: f64,
    hunger: f64,
    health: f64,
    rest_time_left: f64,
}

#[derive(Deserialize)]
struct SourceJson {
    x: f64,
    y: f64,
    radius: f64,
}

#[derive(Deserialize)]
struct PendingJson {
    neuron_ids: Vec<String>,
    strength: f64,
}

#[derive(Serialize)]
struct CreateResp {
    sim_id: u32,
}

#[derive(Serialize)]
struct StepResp {
    activity: Vec<f32>,
    activity_sparse: HashMap<String, f64>,
    motor_left: f64,
    motor_right: f64,
    motor_fwd: f64,
}

#[derive(Serialize)]
struct ErrResp {
    error: String,
}

fn handle(
    s: &mut UnixStream,
    sims: &Mutex<HashMap<u32, BrainSim>>,
    next_id: &Mutex<u32>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut line = String::new();
    BufReader::new(s.try_clone()?).read_line(&mut line)?;
    let line = line.trim();
    if line.is_empty() {
        return Ok(());
    }

    let out = if line.contains("\"method\":\"create\"") {
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p: CreateParams = serde_json::from_value(v["params"].clone())?;
        let conns: Vec<(String, String, f64)> = p
            .connections
            .iter()
            .map(|c| (c.pre.clone(), c.post.clone(), c.weight.unwrap_or(1.0)))
            .collect();
        let sim = BrainSim::new(
            p.neuron_ids,
            conns,
            p.sensory_indices,
            p.motor_left,
            p.motor_right,
            p.motor_unknown,
        );
        let mut g = next_id.lock().unwrap();
        let id = *g;
        *g = g.saturating_add(1);
        drop(g);
        sims.lock().unwrap().insert(id, sim);
        serde_json::to_string(&CreateResp { sim_id: id })?
    } else if line.contains("\"method\":\"step\"") {
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p: StepParams = serde_json::from_value(v["params"].clone())?;
        let mut g = sims.lock().unwrap();
        let sim = g.get_mut(&p.sim_id).ok_or("sim not found")?;
        let fly = FlyInput {
            x: p.fly.x,
            y: p.fly.y,
            z: p.fly.z,
            heading: p.fly.heading,
            t: p.fly.t,
            hunger: p.fly.hunger,
            health: p.fly.health,
            rest_time_left: p.fly.rest_time_left,
        };
        let srcs: Vec<SourceInput> = p
            .sources
            .iter()
            .map(|x| SourceInput {
                x: x.x,
                y: x.y,
                radius: x.radius,
            })
            .collect();
        let pend: Vec<PendingStimInput> = p
            .pending
            .iter()
            .map(|x| PendingStimInput {
                neuron_ids: x.neuron_ids.clone(),
                strength: x.strength,
            })
            .collect();
        let (activity, activity_sparse, motor_left, motor_right, motor_fwd) =
            sim.step(p.dt, fly, srcs, pend);
        serde_json::to_string(&StepResp {
            activity,
            activity_sparse,
            motor_left,
            motor_right,
            motor_fwd,
        })?
    } else {
        serde_json::to_string(&ErrResp {
            error: "unknown method".into(),
        })?
    };

    s.write_all(out.as_bytes())?;
    s.write_all(b"\n")?;
    s.flush()?;
    Ok(())
}
