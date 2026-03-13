//! Brain sim service - Unix socket server.
//! Loads connectome once at startup; create allocates sims from the in-memory template.
use std::time::Instant;
use brain_sim_service::connectome;
use brain_sim_service::sim::{BrainSim, FlyInput, PendingStimInput, SourceInput};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Mutex};

fn main() {
    let default_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("data/connectome-subset.json"))
        .filter(|p| p.exists())
        .and_then(|p| p.canonicalize().ok())
        .map(|p| p.to_string_lossy().into_owned());
    let connectome_path = std::env::var("NEUROSIM_CONNECTOME_PATH")
        .ok()
        .or(default_path)
        .expect("NEUROSIM_CONNECTOME_PATH unset and no default data/connectome-subset.json");
    eprintln!("[brain-service] loading connectome from {}", connectome_path);
    let template = connectome::load_connectome(Path::new(&connectome_path))
        .expect("load connectome");
    eprintln!(
        "[brain-service] connectome loaded: {} neurons, {} connections",
        template.neuron_ids.len(),
        template.connections.len()
    );

    let socket_path = std::env::var("NEUROSIM_BRAIN_SOCKET")
        .unwrap_or_else(|_| "/tmp/neurosim-brain.sock".to_string());
    if Path::new(&socket_path).exists() {
        let _ = std::fs::remove_file(&socket_path);
    }
    let listener = UnixListener::bind(&socket_path).expect("bind socket");
    eprintln!("[brain-service] listening on {}", socket_path);

    let sims: Mutex<HashMap<u32, BrainSim>> = Mutex::new(HashMap::new());
    let next_id: Mutex<u32> = Mutex::new(0);
    let template = Arc::new(template);

    for stream in listener.incoming() {
        if let Ok(mut s) = stream {
            let _ = handle(&mut s, &sims, &next_id, template.clone());
        }
    }
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
    template: Arc<connectome::ConnectomeTemplate>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut reader = BufReader::new(s.try_clone()?);
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
    let out = if line.contains("\"method\":\"ping\"") {
        eprintln!("[brain-service] ping from API ✓");
        r#"{"ok":true}"#.to_string()
    } else if line.contains("\"method\":\"create\"") {
        let sim = BrainSim::new(
            template.neuron_ids.clone(),
            template.connections.clone(),
            template.sensory_indices.clone(),
            template.motor_left.clone(),
            template.motor_right.clone(),
            template.motor_unknown.clone(),
        );
        let mut g = next_id.lock().unwrap();
        let id = *g;
        *g = g.saturating_add(1);
        drop(g);
        sims.lock().unwrap().insert(id, sim);
        eprintln!("[brain-service] create sim {} (from template)", id);
        serde_json::to_string(&CreateResp { sim_id: id })?
    } else if line.contains("\"method\":\"step\"") {
        let t0 = Instant::now();
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p: StepParams = serde_json::from_value(v["params"].clone())?;
        let parse_ms = t0.elapsed().as_millis();
        let mut g = sims.lock().unwrap();
        let sim = g.get_mut(&p.sim_id);
        let sim = match sim {
            Some(sim) => sim,
            None => {
                let err = serde_json::to_string(&ErrResp {
                    error: format!("sim {} not found", p.sim_id),
                })?;
                s.write_all(err.as_bytes())?;
                s.write_all(b"\n")?;
                s.flush()?;
                continue;
            }
        };
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
        let t1 = Instant::now();
        let (_activity, activity_sparse, motor_left, motor_right, motor_fwd) =
            sim.step(p.dt, fly, srcs, pend);
        let compute_ms = t1.elapsed().as_millis();
        let t2 = Instant::now();
        let out_json = serde_json::to_string(&StepResp {
            activity_sparse,
            motor_left,
            motor_right,
            motor_fwd,
        })?;
        let serialize_ms = t2.elapsed().as_millis();
        static STEP_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = STEP_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n % 60 == 0 {
            eprintln!(
                "[brain-service] step timing parse={}ms compute={}ms serialize={}ms total={}ms",
                parse_ms, compute_ms, serialize_ms, t0.elapsed().as_millis()
            );
        }
        out_json
    } else {
        serde_json::to_string(&ErrResp {
            error: "unknown method".into(),
        })?
    };

    s.write_all(out.as_bytes())?;
    s.write_all(b"\n")?;
    s.flush()?;
    }
    Ok(())
}
