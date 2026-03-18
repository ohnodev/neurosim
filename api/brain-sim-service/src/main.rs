//! Brain sim service - Unix socket server.
//! Loads connectome once at startup; create allocates sims from the in-memory template.
use std::time::Instant;
use brain_sim_service::connectome;
use brain_sim_service::feeding::{
    FoodState, FEED_SUGAR_PER_SEC, HEALTH_PER_SUGAR, HUNGER_PER_SUGAR,
};
use brain_sim_service::sim::{BrainSim, FlyInput, SourceInput};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);
static GLOBAL_REQ_ID: AtomicU64 = AtomicU64::new(1);
static STEP_COUNT: AtomicU64 = AtomicU64::new(0);
const MAX_FORCED_SPIKES: usize = 4096;
const MAX_FORCED_SPIKE_ID_LEN: usize = 128;

fn main() {
    let default_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join("data/raw/2025_Connectivity_783.parquet"))
        .filter(|p| p.exists())
        .and_then(|p| p.canonicalize().ok())
        .map(|p| p.to_string_lossy().into_owned());
    let connectome_path = std::env::var("NEUROSIM_CONNECTOME_PATH")
        .ok()
        .or(default_path)
        .expect("NEUROSIM_CONNECTOME_PATH unset and data/raw/2025_Connectivity_783.parquet not found");
    eprintln!("[brain-service] loading connectome from {}", connectome_path);
    let template = connectome::load_connectome(Path::new(&connectome_path))
        .expect("load connectome");
    eprintln!(
        "[brain-service] connectome loaded: {} neurons, {} connections, viewer_subset={}",
        template.neuron_ids.len(),
        template.edges_pre.len(),
        template.viewer_subset_indices.len()
    );

    let socket_path = std::env::var("NEUROSIM_BRAIN_SOCKET")
        .unwrap_or_else(|_| "/tmp/neurosim-brain.sock".to_string());
    if Path::new(&socket_path).exists() {
        let _ = std::fs::remove_file(&socket_path);
    }
    let listener = UnixListener::bind(&socket_path).expect("bind socket");
    eprintln!("[brain-service] listening on {}", socket_path);

    let sims: Mutex<HashMap<u32, BrainSim>> = Mutex::new(HashMap::new());
    let food_state: Mutex<FoodState> = Mutex::new(FoodState::default());
    let next_id: Mutex<u32> = Mutex::new(0);
    let template = Arc::new(template);

    for stream in listener.incoming() {
        if let Ok(mut s) = stream {
            let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "[brain-service] conn_open conn_id={} pid={}",
                conn_id,
                std::process::id()
            );
            let _ = handle(&mut s, &sims, &food_state, &next_id, template.clone(), conn_id);
            eprintln!(
                "[brain-service] conn_close conn_id={} pid={}",
                conn_id,
                std::process::id()
            );
        }
    }
}


#[derive(Deserialize)]
struct StepParams {
    sim_id: u32,
    dt: f64,
    include_activity: Option<bool>,
    olfactory_baseline_rate_hz: Option<f64>,
    #[serde(default)]
    forced_spikes: Vec<String>,
    fly: FlyJson,
    sources: Vec<SourceJson>,
}

#[derive(Deserialize)]
struct StepManyParams {
    steps: Vec<StepParams>,
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
    #[serde(default)]
    dead: bool,
}

#[derive(Deserialize)]
struct SourceJson {
    id: String,
    x: f64,
    y: f64,
    radius: f64,
}

#[derive(Serialize)]
struct FlyRespJson {
    x: f64,
    y: f64,
    z: f64,
    heading: f64,
    t: f64,
    hunger: f64,
    health: f64,
    dead: bool,
    fly_time_left: f64,
    rest_time_left: f64,
    rest_duration: f64,
    feeding: bool,
}

#[derive(Serialize)]
struct CreateResp {
    sim_id: u32,
}

#[derive(Serialize)]
struct StepResp {
    activity_sparse: HashMap<String, f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    spike_ids_step: Vec<String>,
    motor_left: f64,
    motor_right: f64,
    motor_fwd: f64,
    motor_left_count: f64,
    motor_right_count: f64,
    motor_fwd_count: f64,
    motor_left_magnitude: f64,
    motor_right_magnitude: f64,
    motor_fwd_magnitude: f64,
    fly: FlyRespJson,
    eaten_food_id: Option<String>,
    feeding_sugar_taken: f64,
    compute_ms: f64,
    kernel_ms: f64,
    recurrent_ms: f64,
    lif_ms: f64,
    readout_ms: f64,
}

#[derive(Serialize)]
struct StepManyItemResp {
    sim_id: u32,
    activity_sparse: HashMap<String, f64>,
    motor_left: f64,
    motor_right: f64,
    motor_fwd: f64,
    motor_left_count: f64,
    motor_right_count: f64,
    motor_fwd_count: f64,
    motor_left_magnitude: f64,
    motor_right_magnitude: f64,
    motor_fwd_magnitude: f64,
    fly: FlyRespJson,
    eaten_food_id: Option<String>,
    feeding_sugar_taken: f64,
    #[serde(skip_serializing)]
    feeding_candidate_id: Option<String>,
    #[serde(skip_serializing)]
    dt: f64,
    compute_ms: f64,
    kernel_ms: f64,
    recurrent_ms: f64,
    lif_ms: f64,
    readout_ms: f64,
}

#[derive(Deserialize)]
struct RunStepsParams {
    sim_id: u32,
    num_steps: u32,
    dt: f64,
    #[serde(default)]
    stim_rates_by_id: HashMap<String, f64>,
    count_neuron_ids: Option<Vec<String>>,
    #[serde(default)]
    record_ticks: bool,
}

#[derive(Serialize)]
struct ReplayTickResp {
    tick: u32,
    time_sec: f64,
    spikes: Vec<String>,
}

#[derive(Serialize)]
struct RunStepsResp {
    steps_done: u32,
    duration_sec: f64,
    wall_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    spike_counts: Option<HashMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticks: Option<Vec<ReplayTickResp>>,
}

fn apply_feeding_tick(
    food_state: &mut FoodState,
    source_lookup: &HashMap<String, (f64, f64)>,
    items: &mut [StepManyItemResp],
) {
    for item in items.iter_mut() {
        let sugar_per_fly = (FEED_SUGAR_PER_SEC * item.dt).max(0.0);
        if sugar_per_fly <= 0.0 {
            item.fly.feeding = false;
            item.feeding_sugar_taken = 0.0;
            continue;
        }
        let Some(source_id) = item.feeding_candidate_id.clone() else {
            item.fly.feeding = false;
            item.feeding_sugar_taken = 0.0;
            continue;
        };
        let taken = food_state.take_sugar(&source_id, sugar_per_fly);
        item.fly.feeding = taken > 0.0;
        item.feeding_sugar_taken = taken;
        item.fly.hunger = (item.fly.hunger + taken * HUNGER_PER_SUGAR).clamp(0.0, 100.0);
        item.fly.health = (item.fly.health + taken * HEALTH_PER_SUGAR).clamp(0.0, 100.0);
        if let Some((sx, sy)) = source_lookup.get(&source_id) {
            item.fly.x = *sx;
            item.fly.y = *sy;
            item.fly.z = 0.9;
        }
        if food_state.depleted(&source_id) {
            item.eaten_food_id = Some(source_id);
        }
    }
}

#[derive(Serialize)]
struct StepManyResp {
    results: Vec<StepManyItemResp>,
}

#[derive(Serialize)]
struct ErrResp {
    error: String,
}

fn validate_forced_spikes(forced_spikes: &[String]) -> Result<(), String> {
    if forced_spikes.len() > MAX_FORCED_SPIKES {
        return Err(format!(
            "forced_spikes has {} entries; max {}",
            forced_spikes.len(),
            MAX_FORCED_SPIKES
        ));
    }
    for (idx, id) in forced_spikes.iter().enumerate() {
        let len = id.len();
        if len == 0 {
            return Err(format!("forced_spikes[{}] is empty", idx));
        }
        if len > MAX_FORCED_SPIKE_ID_LEN {
            return Err(format!(
                "forced_spikes[{}] length {} exceeds max {}",
                idx, len, MAX_FORCED_SPIKE_ID_LEN
            ));
        }
    }
    Ok(())
}

fn handle(
    s: &mut UnixStream,
    sims: &Mutex<HashMap<u32, BrainSim>>,
    food_state: &Mutex<FoodState>,
    next_id: &Mutex<u32>,
    template: Arc<connectome::ConnectomeTemplate>,
    conn_id: u64,
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
    let req_id = GLOBAL_REQ_ID.fetch_add(1, Ordering::Relaxed);
    let out = if line.contains("\"method\":\"ping\"") {
        eprintln!(
            "[brain-service] req={} conn={} method=ping pid={} ok=1",
            req_id,
            conn_id,
            std::process::id()
        );
        r#"{"ok":true}"#.to_string()
    } else if line.contains("\"method\":\"create\"") {
        let w_syn = std::env::var("NEUROSIM_W_SYN")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .filter(|&v| v.is_finite() && v > 0.0)
            .unwrap_or_else(|| brain_sim_service::model_constants::W_SYN);
        let epg_recurrence_boost = std::env::var("NEUROSIM_EPG_RECURRENCE_BOOST")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .filter(|&v| v.is_finite() && v >= 0.0)
            .unwrap_or_else(|| brain_sim_service::model_constants::EPG_RECURRENCE_BOOST);
        let mut sim = BrainSim::new_with_viewer(
            template.neuron_ids.clone(),
            template.edges_pre.clone(),
            template.edges_post.clone(),
            template.edges_weight.clone(),
            template.out_offsets.clone(),
            template.out_post.clone(),
            template.out_weight.clone(),
            w_syn,
            epg_recurrence_boost,
            template.sensory_indices.clone(),
            template.sensory_left_indices.clone(),
            template.sensory_right_indices.clone(),
            template.sensory_unknown_indices.clone(),
            template.motor_left.clone(),
            template.motor_right.clone(),
            template.motor_unknown.clone(),
            template.viewer_subset_indices.clone(),
        );
        let mut g = next_id.lock().unwrap();
        let id = *g;
        *g = g.saturating_add(1);
        drop(g);
        if let Some(base_seed) = std::env::var("NEUROSIM_POISSON_SEED")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
        {
            // Python parity: first created sim uses seed+1.
            sim.set_rng_seed(base_seed.wrapping_add(id as u64).wrapping_add(1));
        }
        sims.lock().unwrap().insert(id, sim);
        eprintln!(
            "[brain-service] req={} conn={} method=create sim_id={} pid={}",
            req_id,
            conn_id,
            id,
            std::process::id()
        );
        serde_json::to_string(&CreateResp { sim_id: id })?
    } else if line.contains("\"method\":\"step_many\"") {
        let t0 = Instant::now();
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p: StepManyParams = serde_json::from_value(v["params"].clone())?;
        let parse_ms = t0.elapsed().as_millis();
        let mut forced_spikes_validation_error: Option<String> = None;
        for (i, step) in p.steps.iter().enumerate() {
            if let Err(err) = validate_forced_spikes(&step.forced_spikes) {
                forced_spikes_validation_error =
                    Some(format!("invalid step_many.steps[{}].forced_spikes: {}", i, err));
                break;
            }
        }
        if let Some(error) = forced_spikes_validation_error {
            serde_json::to_string(&ErrResp { error })?
        } else {
        let step_count = p.steps.len();
        let mut all_sources: HashMap<String, SourceJson> = HashMap::new();
        for step in &p.steps {
            for s in &step.sources {
                all_sources.entry(s.id.clone()).or_insert(SourceJson {
                    id: s.id.clone(),
                    x: s.x,
                    y: s.y,
                    radius: s.radius,
                });
            }
        }
        let source_list: Vec<SourceJson> = all_sources.into_values().collect();
        let source_lookup: HashMap<String, (f64, f64)> = source_list
            .iter()
            .map(|s| (s.id.clone(), (s.x, s.y)))
            .collect();
        // This service currently processes one socket request at a time per process,
        // so a single batch lock does not reduce real concurrency in this execution model.
        let mut g = sims.lock().unwrap();
        let mut results = Vec::with_capacity(step_count);
        let mut kernel_ms_sum: f64 = 0.0;
        let mut recurrent_ms_sum: f64 = 0.0;
        let mut lif_ms_sum: f64 = 0.0;
        let mut readout_ms_sum: f64 = 0.0;
        let mut compute_ms_sum: f64 = 0.0;
        let mut missing_sim: Option<u32> = None;
        for step in p.steps {
            let sim = g.get_mut(&step.sim_id);
            let sim = match sim {
                Some(sim) => sim,
                None => {
                    missing_sim = Some(step.sim_id);
                    break;
                }
            };
            let fly = FlyInput {
                x: step.fly.x,
                y: step.fly.y,
                z: step.fly.z,
                heading: step.fly.heading,
                t: step.fly.t,
                hunger: step.fly.hunger,
                health: step.fly.health,
                rest_time_left: step.fly.rest_time_left,
                dead: step.fly.dead,
            };
            let srcs: Vec<SourceInput> = step
                .sources
                .iter()
                .map(|x| SourceInput {
                    id: x.id.clone(),
                    x: x.x,
                    y: x.y,
                    radius: x.radius,
                })
                .collect();
            let include_activity = step.include_activity.unwrap_or(true);
        let (
            _activity,
            activity_sparse,
            _spike_ids_step,
            motor_left,
            motor_right,
            motor_fwd,
            motor_left_count,
            motor_right_count,
            motor_fwd_count,
            motor_left_magnitude,
            motor_right_magnitude,
            motor_fwd_magnitude,
            timing,
            fly_out,
        ) =
                sim.step_with_options(
                    step.dt,
                    fly,
                    srcs,
                    include_activity,
                    step.olfactory_baseline_rate_hz,
                    step.forced_spikes,
                    None,
                );
            compute_ms_sum += timing.compute_ms;
            kernel_ms_sum += timing.kernel_ms;
            recurrent_ms_sum += timing.recurrent_ms;
            lif_ms_sum += timing.lif_ms;
            readout_ms_sum += timing.readout_ms;
            results.push(StepManyItemResp {
                sim_id: step.sim_id,
                activity_sparse,
                motor_left,
                motor_right,
                motor_fwd,
                motor_left_count,
                motor_right_count,
                motor_fwd_count,
                motor_left_magnitude,
                motor_right_magnitude,
                motor_fwd_magnitude,
                fly: FlyRespJson {
                    x: fly_out.x,
                    y: fly_out.y,
                    z: fly_out.z,
                    heading: fly_out.heading,
                    t: fly_out.t,
                    hunger: fly_out.hunger,
                    health: fly_out.health,
                    dead: fly_out.dead,
                    fly_time_left: fly_out.fly_time_left,
                    rest_time_left: fly_out.rest_time_left,
                    rest_duration: fly_out.rest_duration,
                    feeding: fly_out.feeding,
                },
                eaten_food_id: fly_out.eaten_food_id,
                feeding_sugar_taken: fly_out.feeding_sugar_taken,
                feeding_candidate_id: fly_out.feeding_candidate_id,
                dt: step.dt,
                compute_ms: timing.compute_ms,
                kernel_ms: timing.kernel_ms,
                recurrent_ms: timing.recurrent_ms,
                lif_ms: timing.lif_ms,
                readout_ms: timing.readout_ms,
            });
        }
        {
            let mut fg = food_state.lock().unwrap();
            fg.sync(source_list.iter().map(|s| s.id.clone()));
            apply_feeding_tick(&mut fg, &source_lookup, &mut results);
        }
        // Atomic semantics are intentional: if any sim_id in step_many is missing,
        // we return an error for the full batch so API/client can retry coherently.
        if let Some(missing_id) = missing_sim {
            serde_json::to_string(&ErrResp {
                error: format!("sim {} not found", missing_id),
            })?
        } else {
        let t2 = Instant::now();
        let out_json = serde_json::to_string(&StepManyResp { results })?;
        let serialize_ms = t2.elapsed().as_millis();
        let n = STEP_COUNT.fetch_add(1, Ordering::Relaxed);
        if n % 20 == 0 {
            eprintln!(
                "[brain-service] req={} conn={} method=step_many sims={} parse_ms={} compute_ms={:.3} kernel_ms={:.3} recurrent_ms={:.3} lif_ms={:.3} readout_ms={:.3} serialize_ms={} total_ms={} pid={}",
                req_id,
                conn_id,
                step_count,
                parse_ms,
                compute_ms_sum,
                kernel_ms_sum,
                recurrent_ms_sum,
                lif_ms_sum,
                readout_ms_sum,
                serialize_ms,
                t0.elapsed().as_millis(),
                std::process::id()
            );
        }
        out_json
        }
        }
    } else if line.contains("\"method\":\"step\"") {
        let t0 = Instant::now();
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p: StepParams = serde_json::from_value(v["params"].clone())?;
        let parse_ms = t0.elapsed().as_millis();
        if let Err(err) = validate_forced_spikes(&p.forced_spikes) {
            let err_json = serde_json::to_string(&ErrResp {
                error: format!("invalid forced_spikes: {}", err),
            })?;
            s.write_all(err_json.as_bytes())?;
            s.write_all(b"\n")?;
            s.flush()?;
            continue;
        }
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
            dead: p.fly.dead,
        };
        let srcs: Vec<SourceInput> = p
            .sources
            .iter()
            .map(|x| SourceInput {
                id: x.id.clone(),
                x: x.x,
                y: x.y,
                radius: x.radius,
            })
            .collect();
        let include_activity = p.include_activity.unwrap_or(true);
        let (
            _activity,
            activity_sparse,
            spike_ids_step,
            motor_left,
            motor_right,
            motor_fwd,
            motor_left_count,
            motor_right_count,
            motor_fwd_count,
            motor_left_magnitude,
            motor_right_magnitude,
            motor_fwd_magnitude,
            timing,
            fly_out,
        ) =
            sim.step_with_options(
                p.dt,
                fly,
                srcs,
                include_activity,
                p.olfactory_baseline_rate_hz,
                p.forced_spikes,
                None,
            );
        let compute_ms = timing.compute_ms;
        let mut source_lookup: HashMap<String, (f64, f64)> = HashMap::new();
        for s in &p.sources {
            source_lookup.insert(s.id.clone(), (s.x, s.y));
        }
        let mut one = vec![StepManyItemResp {
            sim_id: p.sim_id,
            activity_sparse: HashMap::new(),
            motor_left: 0.0,
            motor_right: 0.0,
            motor_fwd: 0.0,
            motor_left_count: 0.0,
            motor_right_count: 0.0,
            motor_fwd_count: 0.0,
            motor_left_magnitude: 0.0,
            motor_right_magnitude: 0.0,
            motor_fwd_magnitude: 0.0,
            fly: FlyRespJson {
                x: fly_out.x,
                y: fly_out.y,
                z: fly_out.z,
                heading: fly_out.heading,
                t: fly_out.t,
                hunger: fly_out.hunger,
                health: fly_out.health,
                dead: fly_out.dead,
                fly_time_left: fly_out.fly_time_left,
                rest_time_left: fly_out.rest_time_left,
                rest_duration: fly_out.rest_duration,
                feeding: fly_out.feeding,
            },
            eaten_food_id: fly_out.eaten_food_id,
            feeding_sugar_taken: fly_out.feeding_sugar_taken,
            feeding_candidate_id: fly_out.feeding_candidate_id,
            dt: p.dt,
            compute_ms: timing.compute_ms,
            kernel_ms: timing.kernel_ms,
            recurrent_ms: timing.recurrent_ms,
            lif_ms: timing.lif_ms,
            readout_ms: timing.readout_ms,
        }];
        {
            let mut fg = food_state.lock().unwrap();
            fg.sync(p.sources.iter().map(|s| s.id.clone()));
            apply_feeding_tick(&mut fg, &source_lookup, &mut one);
        }
        let one_out = one.pop().unwrap();
        let t2 = Instant::now();
        let out_json = serde_json::to_string(&StepResp {
            activity_sparse,
            spike_ids_step,
            motor_left,
            motor_right,
            motor_fwd,
            motor_left_count,
            motor_right_count,
            motor_fwd_count,
            motor_left_magnitude,
            motor_right_magnitude,
            motor_fwd_magnitude,
            fly: one_out.fly,
            eaten_food_id: one_out.eaten_food_id,
            feeding_sugar_taken: one_out.feeding_sugar_taken,
            compute_ms: timing.compute_ms,
            kernel_ms: timing.kernel_ms,
            recurrent_ms: timing.recurrent_ms,
            lif_ms: timing.lif_ms,
            readout_ms: timing.readout_ms,
        })?;
        let serialize_ms = t2.elapsed().as_millis();
        let n = STEP_COUNT.fetch_add(1, Ordering::Relaxed);
        if n % 60 == 0 {
            eprintln!(
                "[brain-service] req={} conn={} method=step sim_id={} parse_ms={} compute_ms={:.3} kernel_ms={:.3} recurrent_ms={:.3} lif_ms={:.3} readout_ms={:.3} serialize_ms={} total_ms={} pid={}",
                req_id,
                conn_id,
                p.sim_id,
                parse_ms,
                compute_ms,
                timing.kernel_ms,
                timing.recurrent_ms,
                timing.lif_ms,
                timing.readout_ms,
                serialize_ms,
                t0.elapsed().as_millis(),
                std::process::id()
            );
        }
        out_json
    } else if line.contains("\"method\":\"run_steps\"") || line.contains("\"method\": \"run_steps\"") {
        let t0 = Instant::now();
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p: RunStepsParams = serde_json::from_value(v["params"].clone())?;
        let num_steps = p.num_steps.min(1_000_000);
        let dt = if p.dt.is_finite() && p.dt > 0.0 {
            p.dt
        } else {
            0.0001
        };
        let mut g = sims.lock().unwrap();
        if !g.contains_key(&p.sim_id) {
            drop(g);
            serde_json::to_string(&ErrResp {
                error: format!("sim {} not found", p.sim_id),
            })?
        } else {
        let sim = g.get_mut(&p.sim_id).unwrap();
        let count_ids = p.count_neuron_ids.as_ref().map(|v| {
            let set: std::collections::HashSet<_> = v.iter().cloned().collect();
            set
        });
        let mut spike_counts: HashMap<String, u64> = count_ids
            .as_ref()
            .map(|ids| ids.iter().map(|id| (id.clone(), 0u64)).collect())
            .unwrap_or_default();
        let mut ticks: Vec<ReplayTickResp> = if p.record_ticks {
            Vec::with_capacity(num_steps as usize)
        } else {
            Vec::new()
        };
        let mut fly = FlyInput {
            x: 0.0,
            y: 0.0,
            z: 1.0,
            heading: 0.0,
            t: 0.0,
            hunger: 100.0,
            health: 100.0,
            rest_time_left: 0.0,
            dead: false,
        };
        let duration_sec = num_steps as f64 * dt;
        for tick_idx in 0..num_steps {
            let (_a, _sparse, spike_ids, _ml, _mr, _mf, _cl, _cr, _cf, _mlm, _mrm, _mfm, _timing, fly_out) =
                sim.step_with_options(dt, fly, Vec::new(), true, None, Vec::new(), Some(&p.stim_rates_by_id));
            fly = FlyInput {
                x: fly_out.x,
                y: fly_out.y,
                z: fly_out.z,
                heading: fly_out.heading,
                t: fly_out.t,
                hunger: fly_out.hunger,
                health: fly_out.health,
                rest_time_left: fly_out.rest_time_left,
                dead: fly_out.dead,
            };
            if count_ids.is_some() {
                for id in &spike_ids {
                    if let Some(c) = spike_counts.get_mut(id) {
                        *c += 1;
                    }
                }
            }
            if p.record_ticks {
                let mut sorted: Vec<String> = spike_ids;
                sorted.sort();
                ticks.push(ReplayTickResp {
                    tick: tick_idx,
                    time_sec: (tick_idx as f64 + 1.0) * dt,
                    spikes: sorted,
                });
            }
        }
        let wall_sec = t0.elapsed().as_secs_f64();
        let run_out = RunStepsResp {
            steps_done: num_steps,
            duration_sec,
            wall_sec,
            spike_counts: if count_ids.is_some() {
                Some(spike_counts)
            } else {
                None
            },
            ticks: if p.record_ticks { Some(ticks) } else { None },
        };
        eprintln!(
            "[brain-service] req={} conn={} method=run_steps sim_id={} steps={} dt={:.6} wall_sec={:.3} pid={}",
            req_id,
            conn_id,
            p.sim_id,
            num_steps,
            dt,
            wall_sec,
            std::process::id()
        );
        serde_json::to_string(&run_out)?
        }
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
