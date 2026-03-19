//! Brain sim service - Unix socket server.
//! Loads connectome once at startup; create allocates sims from the in-memory template.
use std::time::Instant;
use brain_sim_service::connectome;
use brain_sim_service::feeding::{
    FoodState, FEED_SUGAR_PER_SEC, HEALTH_PER_SUGAR, HUNGER_PER_SUGAR,
};
use brain_sim_service::sim::{BrainSim, FlyInput, SourceInput};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

/// Default scale for ER1/ER2/ER3 -> EPG inhibitory weights (0.5 = half). NEUROSIM_ER1_EPG_INHIBITION_SCALE, NEUROSIM_ER2_ER3w_EPG_INHIBITION_SCALE override per type; NEUROSIM_ER123_EPG_INHIBITION_SCALE = default for ER1 and other ER.
const ER123_EPG_INHIBITION_SCALE_DEFAULT: f32 = 0.5;
/// ER2/ER3w scale: default 0.5 (same as others); set NEUROSIM_ER2_ER3w_EPG_INHIBITION_SCALE=0.3 for 30%.
const ER2_ER3W_EPG_INHIBITION_SCALE_DEFAULT: f32 = 0.5;

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);
static GLOBAL_REQ_ID: AtomicU64 = AtomicU64::new(1);
static STEP_COUNT: AtomicU64 = AtomicU64::new(0);
const MAX_FORCED_SPIKES: usize = 4096;
const MAX_FORCED_SPIKE_ID_LEN: usize = 128;

/// Full fly-brain connectome: path to parquet with ALL connections (no subset).
/// Every row in the file is loaded and simulated; we do not filter by type or region.
fn connectome_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join("data/raw/2025_Connectivity_783.parquet"))
        .expect("repo layout: api/brain-sim-service under repo root")
}

/// 16-bin order: L5,R4,L6,R3,L7,R2,L8,R1, L1,R8,L2,R7,L3,R6,L4,R5 (matches frontend compass).
fn epg_side_tile_to_bin_16(side: &str, tile: u8) -> Option<u8> {
    if tile > 7 {
        return None;
    }
    let t = tile as usize;
    let is_left = side.eq_ignore_ascii_case("left");
    let is_right = side.eq_ignore_ascii_case("right");
    if is_left {
        Some([8, 10, 12, 14, 0, 2, 4, 6][t])
    } else if is_right {
        Some([7, 5, 3, 1, 15, 13, 11, 9][t])
    } else {
        None
    }
}

#[derive(Deserialize)]
struct EpgTileMapEntry {
    root_id: String,
    side: Option<String>,
    tile_index_0_7: Option<u8>,
}

#[derive(Deserialize)]
struct EpgTileMap {
    entries: Vec<EpgTileMapEntry>,
}

fn load_epg_id_to_bin() -> HashMap<String, u8> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(|p| p.parent()) {
        candidates.push(root.join("data/epg-tile-map.json"));
        candidates.push(root.join("api/data/epg-tile-map.json"));
        candidates.push(root.join("world/public/epg-tile-map.json"));
    }
    let path = match candidates.into_iter().find(|p| p.exists()) {
        Some(p) => p,
        None => return HashMap::new(),
    };
    let txt = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return HashMap::new(),
    };
    let map: EpgTileMap = match serde_json::from_str(&txt) {
        Ok(m) => m,
        Err(_) => return HashMap::new(),
    };
    let mut out = HashMap::new();
    for e in map.entries {
        let (Some(side), Some(tile)) = (e.side.as_deref(), e.tile_index_0_7) else {
            continue;
        };
        let Some(bin) = epg_side_tile_to_bin_16(side, tile) else {
            continue;
        };
        out.insert(e.root_id, bin);
    }
    out
}

/// Fill 16 EPG bins from activity_sparse and return (bump_angle_deg, normalized bins 0..1 for frontend).
fn compute_bump_and_epg_bins(
    activity_sparse: &HashMap<String, f64>,
    epg_id_to_bin: &HashMap<String, u8>,
) -> (Option<f64>, [f64; 16]) {
    let mut bins: [f64; 16] = [0.0; 16];
    if epg_id_to_bin.is_empty() {
        return (None, bins);
    }
    for (id, &w) in activity_sparse {
        if let Some(&bin) = epg_id_to_bin.get(id) {
            if (bin as usize) < 16 {
                bins[bin as usize] += w;
            }
        }
    }
    let bin_angle_deg = |bin: usize| 90.0 - (bin as f64) * 22.5;
    let mut sum_cos = 0.0f64;
    let mut sum_sin = 0.0f64;
    for (bin, &w) in bins.iter().enumerate() {
        if w > 0.0 {
            let rad = bin_angle_deg(bin).to_radians();
            sum_cos += w * rad.cos();
            sum_sin += w * rad.sin();
        }
    }
    let bump_deg = if sum_cos.abs() < 1e-10 && sum_sin.abs() < 1e-10 {
        None
    } else {
        Some(sum_sin.atan2(sum_cos).to_degrees())
    };
    let max_bin = bins.iter().cloned().fold(0.0f64, f64::max);
    if max_bin > 0.0 {
        for v in &mut bins {
            *v /= max_bin;
        }
    }
    (bump_deg, bins)
}

fn main() {
    let connectome_path = connectome_path();
    if !connectome_path.exists() {
        eprintln!(
            "[brain-service] connectome not found: {} (run from repo root or set data/raw/2025_Connectivity_783.parquet)",
            connectome_path.display()
        );
        std::process::exit(1);
    }
    let connectome_path = match connectome_path.canonicalize() {
        Ok(p) => p,
        Err(_) => connectome_path,
    };
    eprintln!("[brain-service] loading connectome from {}", connectome_path.display());
    let t_load_start = Instant::now();
    let mut template = connectome::load_connectome(&connectome_path)
        .expect("load connectome");
    let load_sec = t_load_start.elapsed().as_secs_f64();
    eprintln!(
        "[brain-service] connectome loaded in {:.2}s: {} neurons, {} connections, viewer_subset={}",
        load_sec,
        template.neuron_ids.len(),
        template.edges_pre.len(),
        template.viewer_subset_indices.len()
    );

    let classification_path = connectome_path
        .parent()
        .map(|p| p.join("classification.csv"))
        .filter(|p| p.exists())
        .or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(|p| p.parent())
                .map(|r| r.join("data/raw/classification.csv"))
                .filter(|p| p.exists())
        });
    let er1_scale = std::env::var("NEUROSIM_ER1_EPG_INHIBITION_SCALE")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|&v| v.is_finite() && v > 0.0 && v <= 1.0)
        .unwrap_or(ER123_EPG_INHIBITION_SCALE_DEFAULT);
    let er2_er3w_scale = std::env::var("NEUROSIM_ER2_ER3w_EPG_INHIBITION_SCALE")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|&v| v.is_finite() && v > 0.0 && v <= 1.0)
        .unwrap_or(ER2_ER3W_EPG_INHIBITION_SCALE_DEFAULT);
    let other_er_scale = std::env::var("NEUROSIM_ER123_EPG_INHIBITION_SCALE")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|&v| v.is_finite() && v > 0.0 && v <= 1.0)
        .unwrap_or(ER123_EPG_INHIBITION_SCALE_DEFAULT);
    if let Some(ref class_path) = classification_path {
        if let Ok((er_type_map, epg)) = load_er_type_map_and_epg(class_path) {
            let scaled = apply_er_epg_inhibition_scale_per_type(
                &mut template,
                &er_type_map,
                &epg,
                er1_scale,
                er2_er3w_scale,
                other_er_scale,
            );
            eprintln!(
                "[brain-service] ER->EPG inhibition: ER1={}, ER2/ER3w={}, other={} (edges scaled: {})",
                er1_scale, er2_er3w_scale, other_er_scale, scaled
            );
            if let Err(e) = apply_pen_a_right_pathway_balance(&mut template, class_path, &epg) {
                eprintln!("[brain-service] PEN_a right pathway balance skipped: {}", e);
            }
        }
    }

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
    #[cfg(feature = "cuda")]
    {
        let use_cuda = std::env::var("USE_CUDA")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if use_cuda {
            eprintln!("[brain-service] USE_CUDA=1 — initializing GPU...");
            match brain_sim_service::gpu::init_gpu_connectome(&template) {
                Some(conn) => {
                    eprintln!(
                        "[brain-service][gpu] CUDA device ready, connectome on GPU (CSR: {} neurons, {} edges). All sims will use GPU.",
                        conn.n, conn.ne
                    );
                }
                None => {
                    eprintln!("[brain-service][gpu] WARNING: GPU init failed — falling back to CPU for all sims.");
                }
            }
        } else {
            eprintln!("[brain-service] USE_CUDA not set — running CPU-only.");
        }
    }
    #[cfg(not(feature = "cuda"))]
    {
        eprintln!("[brain-service] compiled without CUDA feature — CPU-only mode.");
    }

    let world_stim_presets = Arc::new(build_default_world_stim_presets(classification_path.as_deref()));
    let preset_sizes = (
        world_stim_presets.get("11PM").map(|m| m.len()).unwrap_or(0),
        world_stim_presets.get("3PM").map(|m| m.len()).unwrap_or(0),
        world_stim_presets.get("8PM").map(|m| m.len()).unwrap_or(0),
    );
    eprintln!(
        "[brain-service] world PEN presets resolved at startup: 11PM={} 3PM={} 8PM={}",
        preset_sizes.0, preset_sizes.1, preset_sizes.2
    );
    let template = Arc::new(template);

    let w_syn = std::env::var("NEUROSIM_W_SYN")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|&v| v.is_finite() && v > 0.0)
        .unwrap_or_else(|| brain_sim_service::model_constants::W_SYN);
    let epg_boost_live = std::env::var("NEUROSIM_EPG_RECURRENCE_BOOST")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|&v| v.is_finite() && v >= 0.0)
        .unwrap_or_else(|| brain_sim_service::model_constants::EPG_RECURRENCE_BOOST);

    // Live visualization: extra sim thread that streams EPG ticks. Disabled by default to save resources.
    let live_enabled = std::env::var("NEUROSIM_LIVE_ENABLED")
        .as_ref()
        .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let continuous_live: Option<Arc<ContinuousLiveState>> = if live_enabled {
        classification_path
            .as_ref()
            .and_then(|cp| spawn_continuous_live_thread(template.clone(), cp, w_syn, epg_boost_live))
    } else {
        eprintln!("[brain-service] continuous live disabled (set NEUROSIM_LIVE_ENABLED=1 to enable)");
        None
    };
    let epg_id_to_bin = load_epg_id_to_bin();
    let world_runtime = Some(spawn_world_runtime_thread(
        template.clone(),
        world_stim_presets.clone(),
        epg_id_to_bin.clone(),
    ));

    for stream in listener.incoming() {
        if let Ok(mut s) = stream {
            let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "[brain-service] conn_open conn_id={} pid={}",
                conn_id,
                std::process::id()
            );
            let _ = handle(
                &mut s,
                &sims,
                &food_state,
                &next_id,
                template.clone(),
                world_stim_presets.clone(),
                conn_id,
                continuous_live.clone(),
                world_runtime.clone(),
                &epg_id_to_bin,
            );
            eprintln!(
                "[brain-service] conn_close conn_id={} pid={}",
                conn_id,
                std::process::id()
            );
        }
    }
}

/// Load classification CSV; return (root_id -> hemibrain_type for all ER neurons, EPG root_id set).
fn load_er_type_map_and_epg(path: &Path) -> Result<(HashMap<String, String>, HashSet<String>), std::io::Error> {
    let mut er_type_map = HashMap::new();
    let mut epg = HashSet::new();
    let mut rdr = csv::Reader::from_path(path)?;
    let headers = rdr.headers().map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let root_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("root_id")).unwrap_or(0);
    let hemibrain_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("hemibrain_type")).unwrap_or(6);
    for row in rdr.records() {
        let row = row.map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let root_id = row.get(root_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        let hemibrain = row.get(hemibrain_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        if root_id.is_empty() {
            continue;
        }
        if hemibrain.starts_with("ER") {
            er_type_map.insert(root_id, hemibrain);
        } else if hemibrain.contains("EPG") && hemibrain != "EPGt" {
            epg.insert(root_id);
        }
    }
    Ok((er_type_map, epg))
}

/// Scale ER->EPG inhibitory weights per ER type: ER1=er1_scale, ER2/ER3w=er2_er3w_scale, others=other_scale. Sync out_weight. Returns edges scaled.
fn apply_er_epg_inhibition_scale_per_type(
    template: &mut connectome::ConnectomeTemplate,
    er_type_map: &HashMap<String, String>,
    epg: &HashSet<String>,
    er1_scale: f32,
    er2_er3w_scale: f32,
    other_scale: f32,
) -> usize {
    let mut scaled = 0usize;
    for e in 0..template.edges_pre.len() {
        let pre_idx = template.edges_pre[e] as usize;
        let post_idx = template.edges_post[e] as usize;
        let pre_id = template.neuron_ids.get(pre_idx).map(String::as_str).unwrap_or("");
        let post_id = template.neuron_ids.get(post_idx).map(String::as_str).unwrap_or("");
        if !epg.contains(post_id) || template.edges_weight[e] >= 0.0 {
            continue;
        }
        let scale = match er_type_map.get(pre_id).map(String::as_str) {
            Some("ER1") => er1_scale,
            Some("ER2") | Some("ER3w") => er2_er3w_scale,
            Some(_) => other_scale,
            None => continue,
        };
        template.edges_weight[e] *= scale;
        scaled += 1;
    }
    rebuild_csr_out(template);
    scaled
}

/// Rebuild CSR `out_weight` / `out_post` from `edges_weight` after edge edits.
fn rebuild_csr_out(template: &mut connectome::ConnectomeTemplate) {
    let n = template.neuron_ids.len();
    let num_edges = template.edges_pre.len();
    let mut next = template.out_offsets.clone();
    for e in 0..num_edges {
        let pre = template.edges_pre[e] as usize;
        if pre < n {
            let pos = next[pre] as usize;
            next[pre] += 1;
            template.out_weight[pos] = template.edges_weight[e];
        }
    }
}

/// PEN_a left/right + all ER root_ids (hemibrain starts with ER).
fn load_pen_a_sides_and_er_ids(
    path: &Path,
) -> Result<(HashSet<String>, HashSet<String>, HashSet<String>), std::io::Error> {
    let mut pen_left = HashSet::new();
    let mut pen_right = HashSet::new();
    let mut er_ids = HashSet::new();
    let mut rdr = csv::Reader::from_path(path)?;
    let headers = rdr.headers().map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let root_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("root_id")).unwrap_or(0);
    let hemibrain_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("hemibrain_type")).unwrap_or(6);
    let side_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("side")).unwrap_or(8);
    for row in rdr.records() {
        let row = row.map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let root_id = row.get(root_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        if root_id.is_empty() {
            continue;
        }
        let hemibrain = row.get(hemibrain_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        if hemibrain.starts_with("ER") {
            er_ids.insert(root_id.clone());
        }
        if hemibrain.starts_with("PEN_a") {
            let side = row.get(side_idx).map(|s| s.trim().to_lowercase()).unwrap_or_default();
            if side == "left" {
                pen_left.insert(root_id);
            } else if side == "right" {
                pen_right.insert(root_id);
            }
        }
    }
    Ok((pen_left, pen_right, er_ids))
}

fn parse_pen_a_index(hemibrain_type: &str) -> Option<usize> {
    if !hemibrain_type.starts_with("PEN_a") {
        return None;
    }
    let digits: String = hemibrain_type.chars().filter(|c| c.is_ascii_digit()).collect();
    let idx = digits.parse::<usize>().ok()?;
    if idx == 0 {
        None
    } else {
        Some(idx - 1)
    }
}

fn load_pen_a_by_side_index(path: &Path) -> Result<(Vec<String>, Vec<String>), std::io::Error> {
    let mut left_rows: Vec<(usize, String)> = Vec::new();
    let mut right_rows: Vec<(usize, String)> = Vec::new();
    let mut left_seen = HashSet::new();
    let mut right_seen = HashSet::new();
    let mut rdr = csv::Reader::from_path(path)?;
    let headers = rdr
        .headers()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let root_idx = headers
        .iter()
        .position(|h| h.trim().eq_ignore_ascii_case("root_id"))
        .unwrap_or(0);
    let hemibrain_idx = headers
        .iter()
        .position(|h| h.trim().eq_ignore_ascii_case("hemibrain_type"))
        .unwrap_or(6);
    let side_idx = headers
        .iter()
        .position(|h| h.trim().eq_ignore_ascii_case("side"))
        .unwrap_or(8);
    for row in rdr.records() {
        let row = row.map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let rid = row
            .get(root_idx)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if rid.is_empty() {
            continue;
        }
        let hb = row
            .get(hemibrain_idx)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let Some(idx) = parse_pen_a_index(&hb) else {
            continue;
        };
        let side = row
            .get(side_idx)
            .map(|s| s.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if side == "left" {
            if left_seen.insert(rid.clone()) {
                left_rows.push((idx, rid));
            }
        } else if side == "right" {
            if right_seen.insert(rid.clone()) {
                right_rows.push((idx, rid));
            }
        }
    }
    left_rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    right_rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok((
        left_rows.into_iter().map(|(_, id)| id).collect(),
        right_rows.into_iter().map(|(_, id)| id).collect(),
    ))
}

fn build_default_world_stim_presets(class_path: Option<&Path>) -> HashMap<String, HashMap<String, f64>> {
    let mut out: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let Some(cp) = class_path else {
        return out;
    };
    let Ok((left, right)) = load_pen_a_by_side_index(cp) else {
        return out;
    };
    let mut p11 = HashMap::new();
    if let Some(id) = left.get(0) { p11.insert(id.clone(), 50.0); }
    if let Some(id) = left.get(1) { p11.insert(id.clone(), 50.0); }
    if let Some(id) = left.get(5) { p11.insert(id.clone(), 50.0); }
    let mut p3 = HashMap::new();
    if let Some(id) = left.get(2) { p3.insert(id.clone(), 50.0); }
    if let Some(id) = right.get(5) { p3.insert(id.clone(), 70.0); }
    let mut p8 = HashMap::new();
    if let Some(id) = left.get(3) { p8.insert(id.clone(), 50.0); }
    if let Some(id) = left.get(8) { p8.insert(id.clone(), 50.0); }
    if let Some(id) = right.get(0) { p8.insert(id.clone(), 60.0); }
    out.insert("11PM".to_string(), p11);
    out.insert("3PM".to_string(), p3);
    out.insert("8PM".to_string(), p8);
    out
}

fn poisson_seed_base() -> u64 {
    std::env::var("NEUROSIM_POISSON_SEED")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(17290319)
}

fn apply_sim_poisson_seed(sim: &mut BrainSim, sim_id: u32, explicit_seed: Option<u64>) {
    if let Some(seed) = explicit_seed {
        sim.set_rng_seed(seed);
    } else {
        // Keep create/world_add_fly deterministic parity: first sim uses base+1.
        sim.set_rng_seed(poisson_seed_base().wrapping_add(sim_id as u64).wrapping_add(1));
    }
}

/// Boost right PEN_a -> EPG excitation (and optionally weaken right -> ER / direct inh to EPG).
///
/// - `NEUROSIM_PEN_A_RIGHT_EPG_MATCH_LEFT=1`: scale right PEN_a->EPG excitatory weights so total
///   matches left PEN_a->EPG excitatory total (cap 5×).
/// - Else `NEUROSIM_PEN_A_RIGHT_EPG_EXC_SCALE` (default 1.0): multiply positive right PEN_a->EPG.
/// - `NEUROSIM_PEN_A_RIGHT_EPG_INH_SCALE` (default 1.0): multiply negative right PEN_a->EPG.
/// - `NEUROSIM_PEN_A_RIGHT_TO_ER_SCALE` (default 1.0): multiply all right PEN_a->ER edges.
fn apply_pen_a_right_pathway_balance(
    template: &mut connectome::ConnectomeTemplate,
    class_path: &Path,
    epg: &HashSet<String>,
) -> Result<(), std::io::Error> {
    let match_left = std::env::var("NEUROSIM_PEN_A_RIGHT_EPG_MATCH_LEFT")
        .map(|s| {
            let t = s.trim();
            t == "1" || t.eq_ignore_ascii_case("true") || t.eq_ignore_ascii_case("yes")
        })
        .unwrap_or(false);
    let manual_exc = std::env::var("NEUROSIM_PEN_A_RIGHT_EPG_EXC_SCALE")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);
    let inh_scale = std::env::var("NEUROSIM_PEN_A_RIGHT_EPG_INH_SCALE")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);
    let er_scale = std::env::var("NEUROSIM_PEN_A_RIGHT_TO_ER_SCALE")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);

    let (pen_left, pen_right, er_ids) = load_pen_a_sides_and_er_ids(class_path)?;
    if pen_right.is_empty() {
        return Ok(());
    }

    let mut left_exc: f64 = 0.0;
    let mut right_exc: f64 = 0.0;
    if match_left {
        for e in 0..template.edges_pre.len() {
            let pre_idx = template.edges_pre[e] as usize;
            let post_idx = template.edges_post[e] as usize;
            let pre_id = template.neuron_ids.get(pre_idx).map(String::as_str).unwrap_or("");
            let post_id = template.neuron_ids.get(post_idx).map(String::as_str).unwrap_or("");
            let w = template.edges_weight[e];
            if w <= 0.0 || !epg.contains(post_id) {
                continue;
            }
            if pen_left.contains(pre_id) {
                left_exc += w as f64;
            }
            if pen_right.contains(pre_id) {
                right_exc += w as f64;
            }
        }
    }

    let exc_scale = if match_left {
        if right_exc > 1e-5 {
            ((left_exc / right_exc) as f32).clamp(1.0, 5.0)
        } else {
            5.0f32
        }
    } else {
        manual_exc
    };

    let touch_epg_exc = (exc_scale - 1.0).abs() > 1e-6;
    let touch_epg_inh = (inh_scale - 1.0).abs() > 1e-6;
    let touch_er = (er_scale - 1.0).abs() > 1e-6;
    if !touch_epg_exc && !touch_epg_inh && !touch_er {
        return Ok(());
    }

    for e in 0..template.edges_pre.len() {
        let pre_idx = template.edges_pre[e] as usize;
        let post_idx = template.edges_post[e] as usize;
        let pre_id = template.neuron_ids.get(pre_idx).map(String::as_str).unwrap_or("");
        if !pen_right.contains(pre_id) {
            continue;
        }
        let post_id = template.neuron_ids.get(post_idx).map(String::as_str).unwrap_or("");
        let w = template.edges_weight[e];
        if epg.contains(post_id) {
            if w > 0.0 && touch_epg_exc {
                template.edges_weight[e] *= exc_scale;
            } else if w < 0.0 && touch_epg_inh {
                template.edges_weight[e] *= inh_scale;
            }
        } else if er_ids.contains(post_id) && touch_er {
            template.edges_weight[e] *= er_scale;
        }
    }
    rebuild_csr_out(template);
    eprintln!(
        "[brain-service] PEN_a right: EPG exc ×{:.3} (match_left={}), EPG inh ×{:.3}, ->ER ×{:.3}",
        exc_scale, match_left, inh_scale, er_scale
    );
    Ok(())
}

#[derive(Deserialize)]
struct StepParams {
    sim_id: u32,
    dt: f64,
    include_activity: Option<bool>,
    olfactory_baseline_rate_hz: Option<f64>,
    /// When present and non-empty: use these PEN_a rates for this step and skip olfactory/sensory drive.
    #[serde(default)]
    rates_by_id: Option<HashMap<String, f64>>,
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

#[derive(Clone, Serialize)]
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

#[derive(Serialize, Deserialize)]
struct CreateConnection {
    pre: String,
    post: String,
    #[serde(default)]
    weight: Option<f64>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateParams {
    #[serde(default)]
    rng_seed: Option<u64>,
    /// If set, overrides NEUROSIM_EPG_RECURRENCE_BOOST for this sim only.
    #[serde(default)]
    epg_recurrence_boost: Option<f32>,
    #[serde(default)]
    neuron_ids: Option<Vec<String>>,
    #[serde(default)]
    connections: Option<Vec<CreateConnection>>,
    #[serde(default)]
    sensory_indices: Option<Vec<u32>>,
    #[serde(default)]
    motor_left: Option<Vec<u32>>,
    #[serde(default)]
    motor_right: Option<Vec<u32>>,
    #[serde(default)]
    motor_unknown: Option<Vec<u32>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    bump_angle_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    epg_bins: Option<Vec<f64>>,
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
struct ForcedSpikeScheduleEntry {
    from_tick: u32,
    to_tick: u32,
    neuron_ids: Vec<String>,
    rate_hz: f64,
}

#[derive(Deserialize)]
struct StimPhase {
    num_steps: u32,
    #[serde(default)]
    stim_rates_by_id: HashMap<String, f64>,
}

#[derive(Deserialize)]
struct RunStepsParams {
    sim_id: u32,
    num_steps: u32,
    dt: f64,
    #[serde(default)]
    stim_rates_by_id: HashMap<String, f64>,
    /// If non-empty, run these phases back-to-back in one continuous sim (same fly + RNG stream).
    /// Omitted or empty uses legacy single `stim_rates_by_id` for all `num_steps`.
    #[serde(default)]
    stim_phases: Option<Vec<StimPhase>>,
    count_neuron_ids: Option<Vec<String>>,
    #[serde(default)]
    record_ticks: bool,
    #[serde(default)]
    forced_spike_schedule: Option<Vec<ForcedSpikeScheduleEntry>>,
    /// When set with fly/sources, use as initial state and return final state (one round-trip for world loop).
    #[serde(default)]
    return_final_state: bool,
    #[serde(default)]
    fly: Option<FlyJson>,
    #[serde(default)]
    sources: Option<Vec<SourceJson>>,
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
    /// Server-side time for the step loop only (ms).
    steps_loop_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    spike_counts: Option<HashMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticks: Option<Vec<ReplayTickResp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fly: Option<FlyRespJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activity_sparse: Option<HashMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bump_angle_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    epg_bins: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    motor_left: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    motor_right: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    motor_fwd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eaten_food_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    feeding_sugar_taken: Option<f64>,
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

/// Ring buffer of recent EPG-only ticks from the single continuous live sim.
const LIVE_TICK_BUFFER_CAP: usize = 400_000;

#[derive(Clone, Serialize)]
struct LiveTickRecord {
    tick: u32,
    time_sec: f64,
    spikes: Vec<String>,
}

struct ContinuousLiveState {
    pen_left_hz_bits: AtomicU64,
    pen_right_hz_bits: AtomicU64,
    /// When set, overrides L/R: use this map for stim instead of building from left_hz/right_hz.
    custom_rates: Mutex<Option<HashMap<String, f64>>>,
    tick_buffer: Mutex<VecDeque<LiveTickRecord>>,
    latest_tick: AtomicU32,
    dt_sec: f64,
}

const WORLD_TICK_BUFFER_CAP: usize = 120_000;

#[derive(Deserialize)]
struct WorldAddFlyParams {
    fly: FlyJson,
}

#[derive(Deserialize)]
struct WorldRemoveFlyParams {
    fly_id: u32,
}

#[derive(Deserialize)]
struct WorldSetRatesParams {
    fly_id: u32,
    #[serde(default)]
    rates_by_id: HashMap<String, f64>,
}

#[derive(Deserialize)]
struct WorldSetSourcesParams {
    #[serde(default)]
    sources: Vec<SourceJson>,
}

#[derive(Deserialize)]
struct WorldReadTicksParams {
    #[serde(default)]
    after_tick: u64,
    #[serde(default)]
    max_ticks: usize,
}

#[derive(Clone, Serialize)]
struct WorldTickRecord {
    tick: u64,
    fly_id: u32,
    time_sec: f64,
    spikes: Vec<String>,
}

#[derive(Clone, Serialize)]
struct WorldSnapshotFly {
    fly_id: u32,
    fly: FlyRespJson,
    activity_sparse: HashMap<String, f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bump_angle_deg: Option<f64>,
    epg_bins: Vec<f64>,
    compute_ms: f64,
    kernel_ms: f64,
    recurrent_ms: f64,
    lif_ms: f64,
    readout_ms: f64,
}

#[derive(Serialize)]
struct WorldSnapshotResp {
    ok: bool,
    tick: u64,
    dt_sec: f64,
    flies: Vec<WorldSnapshotFly>,
}

struct WorldFlyRuntime {
    sim: BrainSim,
    fly: FlyInput,
    rates_by_id: HashMap<String, f64>,
    snapshot: WorldSnapshotFly,
    fly_time_left_sec: f64,
    wander_heading_rad: f64,
    wander_time_left_sec: f64,
    feeding_source_id: Option<String>,
    feeding_time_left_sec: f64,
    rng_state: u64,
}

struct WorldRuntimeState {
    next_fly_id: AtomicU32,
    tick: AtomicU64,
    dt_sec: f64,
    steps_per_batch: u32,
    paused: AtomicU32,
    flies: Mutex<HashMap<u32, Arc<Mutex<WorldFlyRuntime>>>>,
    snapshots: Mutex<HashMap<u32, WorldSnapshotFly>>,
    sources: Mutex<Vec<SourceInput>>,
    ticks: Mutex<VecDeque<WorldTickRecord>>,
}

struct WorldFlyStepResult {
    fly_id: u32,
    snapshot: WorldSnapshotFly,
    epg_spikes: Vec<String>,
}

const WORLD_ARENA_LIMIT: f64 = 25.0;
const WORLD_BASE_SPEED_UNITS_PER_SEC: f64 = 18.0;
const WORLD_REST_DURATION_SEC: f64 = 4.0;
const WORLD_FLY_TIME_MAX_SEC: f64 = 6.0;
const WORLD_FEED_DURATION_SEC: f64 = 1.2;
const WORLD_FEED_START_RADIUS: f64 = 2.2;
const WORLD_WANDER_INTERVAL_SEC: f64 = 10.0;
const WORLD_HUNGER_DECAY_PER_SEC: f64 = 1.2;
const WORLD_HEALTH_DECAY_STARVING_PER_SEC: f64 = 2.0;
const WORLD_HEALTH_RECOVERY_FEEDING_PER_SEC: f64 = 1.0;
const WORLD_HUNGER_RECOVERY_FEEDING_PER_SEC: f64 = 14.0;

fn normalize_angle_rad(a: f64) -> f64 {
    let mut out = a;
    while out > std::f64::consts::PI {
        out -= 2.0 * std::f64::consts::PI;
    }
    while out < -std::f64::consts::PI {
        out += 2.0 * std::f64::consts::PI;
    }
    out
}

fn clamp_turn_toward(current: f64, target: f64, max_turn: f64) -> f64 {
    let delta = normalize_angle_rad(target - current);
    if delta > max_turn {
        normalize_angle_rad(current + max_turn)
    } else if delta < -max_turn {
        normalize_angle_rad(current - max_turn)
    } else {
        normalize_angle_rad(current + delta)
    }
}

fn next_uniform01(state: &mut u64) -> f64 {
    // xorshift64*
    let mut x = *state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    let y = x.wrapping_mul(0x2545F4914F6CDD1D);
    (y as f64) / (u64::MAX as f64)
}

fn nearest_source<'a>(x: f64, y: f64, sources: &'a [SourceInput]) -> Option<(&'a SourceInput, f64)> {
    let mut best: Option<(&SourceInput, f64)> = None;
    for s in sources {
        let dx = s.x - x;
        let dy = s.y - y;
        let d = (dx * dx + dy * dy).sqrt();
        match best {
            Some((_, bd)) if d >= bd => {}
            _ => best = Some((s, d)),
        }
    }
    best
}

fn update_world_fly_kinematics(
    runtime: &mut WorldFlyRuntime,
    dt_batch: f64,
    sources_now: &[SourceInput],
    bump_angle_deg: Option<f64>,
) -> bool {
    let fly = &mut runtime.fly;
    let hunger = fly.hunger.clamp(0.0, 100.0);
    let hunger_drive = ((100.0 - hunger) / 100.0).clamp(0.0, 1.0);
    let mut feeding = false;

    let nearest = nearest_source(fly.x, fly.y, sources_now);
    let is_hungry = hunger <= 85.0;

    // Rest/fatigue gate.
    if fly.rest_time_left > 0.0 {
        fly.rest_time_left = (fly.rest_time_left - dt_batch).max(0.0);
        runtime.fly_time_left_sec = (runtime.fly_time_left_sec + dt_batch * 0.75).min(WORLD_FLY_TIME_MAX_SEC);
    } else {
        runtime.fly_time_left_sec = (runtime.fly_time_left_sec - dt_batch).max(0.0);
        if runtime.fly_time_left_sec <= 0.0 {
            fly.rest_time_left = WORLD_REST_DURATION_SEC;
        }
    }

    // Feeding behavior: when hungry and near source, pin to source briefly.
    if runtime.feeding_time_left_sec > 0.0 {
        runtime.feeding_time_left_sec = (runtime.feeding_time_left_sec - dt_batch).max(0.0);
        if let Some(ref sid) = runtime.feeding_source_id {
            if let Some(src) = sources_now.iter().find(|s| &s.id == sid) {
                fly.x = src.x;
                fly.y = src.y;
                fly.z = 0.9;
                feeding = true;
            }
        }
    } else {
        runtime.feeding_source_id = None;
        if let Some((src, dist)) = nearest {
            if is_hungry && dist <= WORLD_FEED_START_RADIUS + src.radius.max(0.0) {
                runtime.feeding_source_id = Some(src.id.clone());
                runtime.feeding_time_left_sec = WORLD_FEED_DURATION_SEC;
                fly.x = src.x;
                fly.y = src.y;
                fly.z = 0.9;
                feeding = true;
            }
        }
    }

    if feeding {
        fly.hunger = (fly.hunger + WORLD_HUNGER_RECOVERY_FEEDING_PER_SEC * dt_batch).clamp(0.0, 100.0);
        fly.health = (fly.health + WORLD_HEALTH_RECOVERY_FEEDING_PER_SEC * dt_batch).clamp(0.0, 100.0);
        runtime.fly_time_left_sec = (runtime.fly_time_left_sec + dt_batch * 0.5).min(WORLD_FLY_TIME_MAX_SEC);
    } else {
        fly.hunger = (fly.hunger - WORLD_HUNGER_DECAY_PER_SEC * dt_batch).clamp(0.0, 100.0);
        if fly.hunger < 15.0 {
            fly.health = (fly.health - WORLD_HEALTH_DECAY_STARVING_PER_SEC * dt_batch).clamp(0.0, 100.0);
        }
        if fly.rest_time_left <= 0.0 {
            let desired_heading = if let Some(deg) = bump_angle_deg {
                normalize_angle_rad(deg.to_radians())
            } else if is_hungry {
                if let Some((src, _)) = nearest {
                    (src.y - fly.y).atan2(src.x - fly.x)
                } else {
                    runtime.wander_heading_rad
                }
            } else {
                runtime.wander_time_left_sec -= dt_batch;
                if runtime.wander_time_left_sec <= 0.0 {
                    let u = next_uniform01(&mut runtime.rng_state);
                    runtime.wander_heading_rad =
                        normalize_angle_rad((u * 2.0 * std::f64::consts::PI) - std::f64::consts::PI);
                    runtime.wander_time_left_sec = WORLD_WANDER_INTERVAL_SEC;
                }
                runtime.wander_heading_rad
            };
            let max_turn_rate = 1.4 + 2.6 * hunger_drive;
            fly.heading = clamp_turn_toward(fly.heading, desired_heading, max_turn_rate * dt_batch);

            let fatigue_scale = (runtime.fly_time_left_sec / WORLD_FLY_TIME_MAX_SEC).clamp(0.0, 1.0);
            let speed = WORLD_BASE_SPEED_UNITS_PER_SEC * (0.35 + 0.65 * fatigue_scale);
            let nx = fly.x + fly.heading.cos() * speed * dt_batch;
            let ny = fly.y + fly.heading.sin() * speed * dt_batch;
            fly.x = nx.clamp(-WORLD_ARENA_LIMIT, WORLD_ARENA_LIMIT);
            fly.y = ny.clamp(-WORLD_ARENA_LIMIT, WORLD_ARENA_LIMIT);
            fly.z = (fly.z + 0.2 * dt_batch).clamp(0.35, 1.1);
        } else {
            fly.z = (fly.z - 0.4 * dt_batch).clamp(0.35, 1.1);
        }
    }

    if fly.health <= 0.0 {
        fly.dead = true;
    }

    feeding
}

fn step_world_fly_runtime(
    fly_id: u32,
    runtime: &mut WorldFlyRuntime,
    dt_sec: f64,
    steps_per_batch: u32,
    sources_now: &[SourceInput],
    epg_id_to_bin: &HashMap<String, u8>,
) -> WorldFlyStepResult {
    let mut fly = FlyInput {
        x: runtime.fly.x,
        y: runtime.fly.y,
        z: runtime.fly.z,
        heading: runtime.fly.heading,
        t: runtime.fly.t,
        hunger: runtime.fly.hunger,
        health: runtime.fly.health,
        rest_time_left: runtime.fly.rest_time_left,
        dead: runtime.fly.dead,
    };
    let mut last_activity_sparse: HashMap<String, f64> = HashMap::new();
    let mut last_spike_ids: Vec<String> = Vec::new();
    let mut last_timing = brain_sim_service::sim::StepTiming {
        compute_ms: 0.0,
        kernel_ms: 0.0,
        recurrent_ms: 0.0,
        lif_ms: 0.0,
        readout_ms: 0.0,
    };
    for step in 0..steps_per_batch {
        let is_last = step + 1 == steps_per_batch;
        let use_stim = !runtime.rates_by_id.is_empty() || !sources_now.is_empty();
        let (_a, activity_sparse, spike_ids, _ml, _mr, _mf, _cl, _cr, _cf, _mlm, _mrm, _mfm, timing, fly_out) =
            if is_last {
                runtime.sim.step_with_options(
                    dt_sec,
                    fly,
                    sources_now.to_vec(),
                    true,
                    use_stim,
                    None,
                    Vec::new(),
                    if runtime.rates_by_id.is_empty() {
                        None
                    } else {
                        Some(&runtime.rates_by_id)
                    },
                    None,
                )
            } else {
                runtime.sim.step_fast(
                    dt_sec,
                    fly,
                    sources_now.to_vec(),
                    use_stim,
                    None,
                    Vec::new(),
                    if runtime.rates_by_id.is_empty() {
                        None
                    } else {
                        Some(&runtime.rates_by_id)
                    },
                    None,
                )
            };
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
        if is_last {
            last_activity_sparse = activity_sparse;
            last_spike_ids = spike_ids;
            last_timing = timing;
        }
    }
    let (bump_angle_deg, epg_bins_arr) = compute_bump_and_epg_bins(&last_activity_sparse, epg_id_to_bin);
    let dt_batch = dt_sec * steps_per_batch as f64;
    let feeding = update_world_fly_kinematics(runtime, dt_batch, sources_now, bump_angle_deg);
    runtime.fly.t = fly.t;
    let snap = WorldSnapshotFly {
        fly_id,
        fly: FlyRespJson {
            x: runtime.fly.x,
            y: runtime.fly.y,
            z: runtime.fly.z,
            heading: runtime.fly.heading,
            t: fly.t,
            hunger: runtime.fly.hunger,
            health: runtime.fly.health,
            dead: runtime.fly.dead,
            fly_time_left: (runtime.fly_time_left_sec / WORLD_FLY_TIME_MAX_SEC).clamp(0.0, 1.0),
            rest_time_left: runtime.fly.rest_time_left.max(0.0),
            rest_duration: WORLD_REST_DURATION_SEC,
            feeding,
        },
        activity_sparse: last_activity_sparse,
        bump_angle_deg,
        epg_bins: epg_bins_arr.to_vec(),
        compute_ms: last_timing.compute_ms,
        kernel_ms: last_timing.kernel_ms,
        recurrent_ms: last_timing.recurrent_ms,
        lif_ms: last_timing.lif_ms,
        readout_ms: last_timing.readout_ms,
    };
    runtime.snapshot = snap.clone();
    let mut epg_spikes: Vec<String> = last_spike_ids
        .into_iter()
        .filter(|id| epg_id_to_bin.contains_key(id))
        .collect();
    epg_spikes.sort();
    WorldFlyStepResult {
        fly_id,
        snapshot: snap,
        epg_spikes,
    }
}

fn spawn_continuous_live_thread(
    template: Arc<connectome::ConnectomeTemplate>,
    class_path: &Path,
    w_syn: f32,
    epg_recurrence_boost: f32,
) -> Option<Arc<ContinuousLiveState>> {
    let (pen_left, pen_right, _) = load_pen_a_sides_and_er_ids(class_path).ok()?;
    if pen_left.is_empty() && pen_right.is_empty() {
        eprintln!("[brain-service] continuous live: no PEN_a in classification, skipping");
        return None;
    }
    let mut pen_left: Vec<String> = pen_left.into_iter().collect();
    let mut pen_right: Vec<String> = pen_right.into_iter().collect();
    pen_left.sort();
    pen_right.sort();
    let epg_ids = load_er_type_map_and_epg(class_path)
        .ok()
        .map(|(_, e)| e)
        .unwrap_or_default();
    let dt = std::env::var("NEUROSIM_LIVE_DT_SEC")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|&v| v.is_finite() && v > 0.0)
        .unwrap_or(0.0001);
    let state = Arc::new(ContinuousLiveState {
        pen_left_hz_bits: AtomicU64::new(0.0f64.to_bits()),
        pen_right_hz_bits: AtomicU64::new(0.0f64.to_bits()),
        custom_rates: Mutex::new(None),
        tick_buffer: Mutex::new(VecDeque::with_capacity(8192)),
        latest_tick: AtomicU32::new(0),
        dt_sec: dt,
    });
    let st = state.clone();
    let tpl = template.clone();
    let n_left = pen_left.len();
    let n_right = pen_right.len();
    std::thread::Builder::new()
        .name("neurosim-continuous-live".into())
        .spawn(move || {
            run_continuous_live_loop(tpl, pen_left, pen_right, epg_ids, w_syn, epg_recurrence_boost, dt, st);
        })
        .ok()?;
    eprintln!(
        "[brain-service] continuous live sim started (PEN_a L={} R={}, dt={}s, cap≈{} ticks)",
        n_left,
        n_right,
        dt,
        LIVE_TICK_BUFFER_CAP
    );
    Some(state)
}

fn run_continuous_live_loop(
    template: Arc<connectome::ConnectomeTemplate>,
    pen_left: Vec<String>,
    pen_right: Vec<String>,
    epg_ids: HashSet<String>,
    w_syn: f32,
    epg_recurrence_boost: f32,
    dt: f64,
    state: Arc<ContinuousLiveState>,
) {
    let mut sim = BrainSim::from_template(template, w_syn, epg_recurrence_boost);
    let seed: u64 = std::env::var("NEUROSIM_LIVE_RNG_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(17290319);
    sim.set_rng_seed(seed);
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
    let mut tick: u32 = 0;
    let mut stim: HashMap<String, f64> = HashMap::new();
    let live_no_sleep = std::env::var("NEUROSIM_LIVE_NO_SLEEP")
        .ok()
        .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let target_interval = std::time::Duration::from_secs_f64(dt.max(0.0));
    eprintln!(
        "[brain-service] continuous live stepping (seed={}, EPG filter {} ids)",
        seed,
        epg_ids.len()
    );
    loop {
        let tick_start = Instant::now();
        let use_custom = {
            let guard = state.custom_rates.lock().unwrap();
            if let Some(ref map) = *guard {
                if !map.is_empty() {
                    stim.clear();
                    for (id, hz) in map.iter() {
                        if hz.is_finite() && *hz > 0.0 {
                            stim.insert(id.clone(), *hz);
                        }
                    }
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };
        if !use_custom {
            let l = f64::from_bits(state.pen_left_hz_bits.load(Ordering::Relaxed));
            let r = f64::from_bits(state.pen_right_hz_bits.load(Ordering::Relaxed));
            stim.clear();
            if l.is_finite() && l > 0.0 {
                for id in &pen_left {
                    stim.insert(id.clone(), l);
                }
            }
            if r.is_finite() && r > 0.0 {
                for id in &pen_right {
                    stim.insert(id.clone(), r);
                }
            }
        }
        let skip_olfactory = !stim.is_empty();
        let (_a, _sparse, spike_ids, _, _, _, _, _, _, _, _, _, _, fly_out) = sim.step_with_options(
            dt,
            fly,
            Vec::new(),
            true,
            skip_olfactory,
            None,
            Vec::new(),
            if stim.is_empty() {
                None
            } else {
                Some(&stim)
            },
            None,
        );
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
        tick = tick.wrapping_add(1);
        if tick == 0 {
            continue;
        }
        let mut epg_spikes: Vec<String> = spike_ids
            .into_iter()
            .filter(|id| epg_ids.contains(id))
            .collect();
        epg_spikes.sort();
        let rec = LiveTickRecord {
            tick,
            time_sec: tick as f64 * dt,
            spikes: epg_spikes,
        };
        state.latest_tick.store(tick, Ordering::Release);
        let mut buf = state.tick_buffer.lock().unwrap();
        buf.push_back(rec);
        while buf.len() > LIVE_TICK_BUFFER_CAP {
            buf.pop_front();
        }
        if !live_no_sleep && target_interval > std::time::Duration::ZERO {
            let elapsed = tick_start.elapsed();
            if elapsed < target_interval {
                std::thread::sleep(target_interval - elapsed);
            }
        }
    }
}

fn spawn_world_runtime_thread(
    template: Arc<connectome::ConnectomeTemplate>,
    world_stim_presets: Arc<HashMap<String, HashMap<String, f64>>>,
    epg_id_to_bin: HashMap<String, u8>,
) -> Arc<WorldRuntimeState> {
    let dt_sec = std::env::var("NEUROSIM_WORLD_DT_SEC")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|&v| v.is_finite() && v > 0.0)
        .unwrap_or(0.0001);
    let steps_per_batch = std::env::var("NEUROSIM_WORLD_STEPS_PER_BATCH")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|&v| v > 0)
        .unwrap_or_else(|| (0.125 / dt_sec).round().max(1.0) as u32);
    let world_parallel_flies = std::env::var("NEUROSIM_WORLD_PARALLEL_FLIES")
        .ok()
        .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let state = Arc::new(WorldRuntimeState {
        next_fly_id: AtomicU32::new(0),
        tick: AtomicU64::new(0),
        dt_sec,
        steps_per_batch,
        paused: AtomicU32::new(0),
        flies: Mutex::new(HashMap::new()),
        snapshots: Mutex::new(HashMap::new()),
        sources: Mutex::new(Vec::new()),
        ticks: Mutex::new(VecDeque::with_capacity(8192)),
    });
    let state_thr = state.clone();
    std::thread::Builder::new()
        .name("neurosim-world-loop".into())
        .spawn(move || {
            let target_interval =
                std::time::Duration::from_secs_f64((dt_sec * steps_per_batch as f64).max(0.0));
            loop {
                let batch_start = Instant::now();
                if state_thr.paused.load(Ordering::Relaxed) == 0 {
                    let sources_now = state_thr.sources.lock().unwrap().clone();
                    let fly_handles: Vec<(u32, Arc<Mutex<WorldFlyRuntime>>)> = {
                        let flies = state_thr.flies.lock().unwrap();
                        flies
                            .iter()
                            .map(|(fly_id, runtime)| (*fly_id, Arc::clone(runtime)))
                            .collect()
                    };
                    let step_results: Vec<WorldFlyStepResult> = if world_parallel_flies {
                        fly_handles
                            .into_par_iter()
                            .map(|(fly_id, runtime_handle)| {
                                let mut runtime = runtime_handle.lock().unwrap();
                                step_world_fly_runtime(
                                    fly_id,
                                    &mut runtime,
                                    dt_sec,
                                    steps_per_batch,
                                    &sources_now,
                                    &epg_id_to_bin,
                                )
                            })
                            .collect()
                    } else {
                        fly_handles
                            .into_iter()
                            .map(|(fly_id, runtime_handle)| {
                                let mut runtime = runtime_handle.lock().unwrap();
                                step_world_fly_runtime(
                                    fly_id,
                                    &mut runtime,
                                    dt_sec,
                                    steps_per_batch,
                                    &sources_now,
                                    &epg_id_to_bin,
                                )
                            })
                            .collect()
                    };
                    let tick = state_thr.tick.load(Ordering::Relaxed) + 1;
                    {
                        let mut snapshots = state_thr.snapshots.lock().unwrap();
                        for result in &step_results {
                            snapshots.insert(result.fly_id, result.snapshot.clone());
                        }
                    }
                    {
                        let mut ticks = state_thr.ticks.lock().unwrap();
                        for result in step_results {
                            ticks.push_back(WorldTickRecord {
                                tick,
                                fly_id: result.fly_id,
                                time_sec: tick as f64 * dt_sec * steps_per_batch as f64,
                                spikes: result.epg_spikes,
                            });
                        }
                        while ticks.len() > WORLD_TICK_BUFFER_CAP {
                            ticks.pop_front();
                        }
                    }
                    state_thr.tick.fetch_add(1, Ordering::Release);
                }
                if target_interval > std::time::Duration::ZERO {
                    let elapsed = batch_start.elapsed();
                    if elapsed < target_interval {
                        std::thread::sleep(target_interval - elapsed);
                    }
                }
            }
        })
        .expect("spawn world runtime thread");
    eprintln!(
        "[brain-service] world runtime started (dt={}s, steps_per_batch={}, batch_interval_ms={:.1}, parallel_flies={})",
        dt_sec,
        steps_per_batch,
        dt_sec * steps_per_batch as f64 * 1000.0,
        world_parallel_flies
    );
    let _ = world_stim_presets;
    state
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
    world_stim_presets: Arc<HashMap<String, HashMap<String, f64>>>,
    conn_id: u64,
    continuous_live: Option<Arc<ContinuousLiveState>>,
    world_runtime: Option<Arc<WorldRuntimeState>>,
    epg_id_to_bin: &HashMap<String, u8>,
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
        let gpu_enabled = {
            #[cfg(feature = "cuda")]
            {
                brain_sim_service::gpu::try_init_device().is_some()
            }
            #[cfg(not(feature = "cuda"))]
            {
                false
            }
        };
        eprintln!(
            "[brain-service] req={} conn={} method=ping pid={} ok=1 gpu={}",
            req_id,
            conn_id,
            std::process::id(),
            if gpu_enabled { 1 } else { 0 }
        );
        serde_json::to_string(&serde_json::json!({
            "ok": true,
            "gpu": gpu_enabled,
        }))?
    } else if line.contains("\"method\":\"create\"") {
        let t_create_start = Instant::now();
        let v: serde_json::Value = serde_json::from_str(line)?;
        let params = v
            .get("params")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let create_params: CreateParams = serde_json::from_value(params)?;
        let w_syn = std::env::var("NEUROSIM_W_SYN")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .filter(|&v| v.is_finite() && v > 0.0)
            .unwrap_or_else(|| brain_sim_service::model_constants::W_SYN);
        let mut epg_recurrence_boost = std::env::var("NEUROSIM_EPG_RECURRENCE_BOOST")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .filter(|&v| v.is_finite() && v >= 0.0)
            .unwrap_or_else(|| brain_sim_service::model_constants::EPG_RECURRENCE_BOOST);
        if let Some(b) = create_params.epg_recurrence_boost {
            if b.is_finite() && b >= 0.0 {
                epg_recurrence_boost = b;
            }
        }
        let t_before_sim = Instant::now();
        let has_overrides = create_params.neuron_ids.is_some()
            || create_params.connections.is_some()
            || create_params.sensory_indices.is_some()
            || create_params.motor_left.is_some()
            || create_params.motor_right.is_some()
            || create_params.motor_unknown.is_some();
        if has_overrides {
            let err_json = serde_json::to_string(&ErrResp {
                error: "topology override fields (neuron_ids, connections, sensory_indices, motor_*) are not yet supported; omit them or pass null".into(),
            })?;
            s.write_all(err_json.as_bytes())?;
            s.write_all(b"\n")?;
            s.flush()?;
            continue;
        }
        let mut sim = BrainSim::from_template(template.clone(), w_syn, epg_recurrence_boost);
        sim.set_world_stim_presets(&world_stim_presets);
        let from_template_ms = t_before_sim.elapsed().as_secs_f64() * 1000.0;
        let mut g = next_id.lock().unwrap();
        let id = *g;
        *g = g.saturating_add(1);
        drop(g);
        apply_sim_poisson_seed(&mut sim, id, create_params.rng_seed);
        sims.lock().unwrap().insert(id, sim);
        let create_total_ms = t_create_start.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "[brain-service] create timing: from_template={:.1}ms total={:.1}ms sim_id={}",
            from_template_ms,
            create_total_ms,
            id
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
            let skip_olfactory = step.rates_by_id.as_ref().map_or(false, |m| !m.is_empty());
            let stim_rates = step.rates_by_id.as_ref().filter(|m| !m.is_empty());
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
                    skip_olfactory,
                    step.olfactory_baseline_rate_hz,
                    step.forced_spikes,
                    stim_rates,
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
        let skip_olfactory = p.rates_by_id.as_ref().map_or(false, |m| !m.is_empty());
        let stim_rates_by_id = p.rates_by_id.as_ref().filter(|m| !m.is_empty());
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
                skip_olfactory,
                p.olfactory_baseline_rate_hz,
                p.forced_spikes,
                stim_rates_by_id,
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
        let (bump_angle_deg, epg_bins_arr) = compute_bump_and_epg_bins(&activity_sparse, epg_id_to_bin);
        let epg_bins = Some(epg_bins_arr.to_vec());
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
            bump_angle_deg,
            epg_bins,
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
        let t_parse_start = Instant::now();
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p: RunStepsParams = serde_json::from_value(v["params"].clone())?;
        let parse_ms = t_parse_start.elapsed().as_secs_f64() * 1000.0;
        let dt = if p.dt.is_finite() && p.dt > 0.0 {
            p.dt
        } else {
            0.0001
        };
        let mut schedule_validation_error: Option<String> = None;
        if let Some(ref schedule) = p.forced_spike_schedule {
            let mut all_ids: HashSet<String> = HashSet::new();
            for (i, entry) in schedule.iter().enumerate() {
                if let Err(err) = validate_forced_spikes(&entry.neuron_ids) {
                    schedule_validation_error = Some(format!(
                        "invalid run_steps.forced_spike_schedule[{}].neuron_ids: {}",
                        i, err
                    ));
                    break;
                }
                for id in &entry.neuron_ids {
                    all_ids.insert(id.clone());
                }
            }
            if schedule_validation_error.is_none() && all_ids.len() > MAX_FORCED_SPIKES {
                schedule_validation_error = Some(format!(
                    "run_steps.forced_spike_schedule aggregate unique IDs {} exceeds max {}",
                    all_ids.len(),
                    MAX_FORCED_SPIKES
                ));
            }
        }
        if let Some(error) = schedule_validation_error {
            serde_json::to_string(&ErrResp { error })?
        } else {
        let mut g = sims.lock().unwrap();
        if !g.contains_key(&p.sim_id) {
            drop(g);
            serde_json::to_string(&ErrResp {
                error: format!("sim {} not found", p.sim_id),
            })?
        } else {
        let sim = g.get_mut(&p.sim_id).unwrap();
        let use_phases = p
            .stim_phases
            .as_ref()
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        let phase_slices: Vec<(u32, &std::collections::HashMap<String, f64>)> = if use_phases {
            let mut out = Vec::new();
            let mut budget = 1_000_000u32;
            for ph in p.stim_phases.as_ref().unwrap() {
                if budget == 0 {
                    break;
                }
                let n = ph.num_steps.min(budget);
                budget -= n;
                out.push((n, &ph.stim_rates_by_id));
            }
            out
        } else {
            vec![(p.num_steps.min(1_000_000), &p.stim_rates_by_id)]
        };
        let num_steps: u32 = phase_slices.iter().map(|(n, _)| *n).sum();
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
        let mut fly = p
            .fly
            .as_ref()
            .map(|f| FlyInput {
                x: f.x,
                y: f.y,
                z: f.z,
                heading: f.heading,
                t: f.t,
                hunger: f.hunger,
                health: f.health,
                rest_time_left: f.rest_time_left,
                dead: f.dead,
            })
            .unwrap_or_else(|| FlyInput {
                x: 0.0,
                y: 0.0,
                z: 1.0,
                heading: 0.0,
                t: 0.0,
                hunger: 100.0,
                health: 100.0,
                rest_time_left: 0.0,
                dead: false,
            });
        let srcs: Vec<SourceInput> = p
            .sources
            .as_ref()
            .map(|s| {
                s.iter()
                    .map(|x| SourceInput {
                        id: x.id.clone(),
                        x: x.x,
                        y: x.y,
                        radius: x.radius,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let duration_sec = num_steps as f64 * dt;
        let mut last_activity_sparse: HashMap<String, f64> = HashMap::new();
        // Log once if any forced-spike IDs are not in the connectome (they will be silently dropped).
        if let Some(ref schedule) = p.forced_spike_schedule {
            let all_forced: Vec<String> = schedule
                .iter()
                .flat_map(|e| e.neuron_ids.iter().cloned())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            if !all_forced.is_empty() {
                sim.log_missing_forced_ids(&all_forced);
            }
        }
        let t_loop_start = Instant::now();
        let mut forced_rng: u64 = (p.sim_id as u64).wrapping_mul(12345).wrapping_add(67890);
        let mut global_tick: u32 = 0;
        let needs_per_step_ids = p.record_ticks || count_ids.is_some();
        for (phase_steps, stim_map) in phase_slices {
            for _step_in_phase in 0..phase_steps {
                let mut forced_spikes: Vec<String> = Vec::new();
                if let Some(ref schedule) = p.forced_spike_schedule {
                    for entry in schedule {
                        if global_tick >= entry.from_tick
                            && global_tick < entry.to_tick
                            && entry.rate_hz > 0.0
                        {
                            let prob = (entry.rate_hz * dt).min(1.0).max(0.0);
                            for id in &entry.neuron_ids {
                                forced_rng = forced_rng
                                    .wrapping_mul(6364136223846793005)
                                    .wrapping_add(1442695040888963407);
                                let u = (forced_rng >> 32) as f64 / (u32::MAX as f64 + 1.0);
                                if u < prob {
                                    forced_spikes.push(id.clone());
                                }
                            }
                        }
                    }
                }
                let is_last = global_tick + 1 == num_steps;
                let use_full_readout = is_last || needs_per_step_ids;
                let use_stim = !stim_map.is_empty() || (p.return_final_state && !srcs.is_empty());
                let (_a, activity_sparse, spike_ids, _ml, _mr, _mf, _cl, _cr, _cf, _mlm, _mrm, _mfm, _timing, fly_out) =
                    if use_full_readout {
                        sim.step_with_options(
                            dt,
                            fly,
                            srcs.clone(),
                            is_last,
                            use_stim,
                            None,
                            forced_spikes,
                            if stim_map.is_empty() { None } else { Some(stim_map) },
                            None,
                        )
                    } else {
                        sim.step_fast(
                            dt,
                            fly,
                            srcs.clone(),
                            use_stim,
                            None,
                            forced_spikes,
                            if stim_map.is_empty() { None } else { Some(stim_map) },
                            None,
                        )
                    };
                if p.return_final_state {
                    if is_last {
                        last_activity_sparse = activity_sparse.clone();
                    }
                }
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
                    let mut sorted: Vec<String> = if let Some(ref set) = count_ids {
                        spike_ids.iter().filter(|id| set.contains(*id)).cloned().collect()
                    } else {
                        spike_ids
                    };
                    sorted.sort();
                    ticks.push(ReplayTickResp {
                        tick: global_tick,
                        time_sec: (global_tick as f64 + 1.0) * dt,
                        spikes: sorted,
                    });
                }
                global_tick = global_tick.wrapping_add(1);
            }
        }
        let steps_loop_ms = t_loop_start.elapsed().as_secs_f64() * 1000.0;
        let wall_sec = t0.elapsed().as_secs_f64();
        let t_serial_start = Instant::now();
        let (resp_fly, resp_activity, resp_bump, resp_epg_bins, resp_motor_left, resp_motor_right, resp_motor_fwd, resp_eaten_food_ids, resp_feeding_sugar_taken) =
            if p.return_final_state {
                let (bump_angle_deg, epg_bins_arr) =
                    compute_bump_and_epg_bins(&last_activity_sparse, epg_id_to_bin);
                (
                    Some(FlyRespJson {
                        x: fly.x,
                        y: fly.y,
                        z: fly.z,
                        heading: fly.heading,
                        t: fly.t,
                        hunger: fly.hunger,
                        health: fly.health,
                        dead: fly.dead,
                        fly_time_left: 1.0,
                        rest_time_left: fly.rest_time_left.max(0.0),
                        rest_duration: 0.0,
                        feeding: false,
                    }),
                    Some(last_activity_sparse),
                    bump_angle_deg,
                    Some(epg_bins_arr.to_vec()),
                    Some(0.0),
                    Some(0.0),
                    Some(0.0),
                    Some(Vec::new()),
                    Some(0.0),
                )
            } else {
                (None, None, None, None, None, None, None, None, None)
            };
        let run_out = RunStepsResp {
            steps_done: num_steps,
            duration_sec,
            wall_sec,
            steps_loop_ms,
            spike_counts: if count_ids.is_some() {
                Some(spike_counts)
            } else {
                None
            },
            ticks: if p.record_ticks { Some(ticks) } else { None },
            fly: resp_fly,
            activity_sparse: resp_activity,
            bump_angle_deg: resp_bump,
            epg_bins: resp_epg_bins,
            motor_left: resp_motor_left,
            motor_right: resp_motor_right,
            motor_fwd: resp_motor_fwd,
            eaten_food_ids: resp_eaten_food_ids,
            feeding_sugar_taken: resp_feeding_sugar_taken,
        };
        let json_str = serde_json::to_string(&run_out)?;
        let serialize_ms = t_serial_start.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "[brain-service] run_steps timing: parse={:.1}ms steps_loop={:.1}ms serialize={:.1}ms wall_total={:.3}s steps={} record_ticks={}",
            parse_ms,
            steps_loop_ms,
            serialize_ms,
            wall_sec,
            num_steps,
            p.record_ticks
        );
        json_str
        }
        }
    } else if line.contains("\"method\":\"world_add_fly\"") || line.contains("\"method\": \"world_add_fly\"")
    {
        if let Some(ref world) = world_runtime {
            let v: serde_json::Value = serde_json::from_str(line)?;
            let p: WorldAddFlyParams = serde_json::from_value(v["params"].clone())?;
            let w_syn = std::env::var("NEUROSIM_W_SYN")
                .ok()
                .and_then(|s| s.parse::<f32>().ok())
                .filter(|&vv| vv.is_finite() && vv > 0.0)
                .unwrap_or_else(|| brain_sim_service::model_constants::W_SYN);
            let epg_recurrence_boost = std::env::var("NEUROSIM_EPG_RECURRENCE_BOOST")
                .ok()
                .and_then(|s| s.parse::<f32>().ok())
                .filter(|&vv| vv.is_finite() && vv >= 0.0)
                .unwrap_or_else(|| brain_sim_service::model_constants::EPG_RECURRENCE_BOOST);
            let mut sim = BrainSim::from_template(template.clone(), w_syn, epg_recurrence_boost);
            sim.set_world_stim_presets(&world_stim_presets);
            let fly_id = world.next_fly_id.fetch_add(1, Ordering::Relaxed);
            apply_sim_poisson_seed(&mut sim, fly_id, None);
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
            let snapshot = WorldSnapshotFly {
                fly_id,
                fly: FlyRespJson {
                    x: fly.x,
                    y: fly.y,
                    z: fly.z,
                    heading: fly.heading,
                    t: fly.t,
                    hunger: fly.hunger,
                    health: fly.health,
                    dead: fly.dead,
                    fly_time_left: 1.0,
                    rest_time_left: fly.rest_time_left.max(0.0),
                    rest_duration: 0.0,
                    feeding: false,
                },
                activity_sparse: HashMap::new(),
                bump_angle_deg: None,
                epg_bins: vec![0.0; 16],
                compute_ms: 0.0,
                kernel_ms: 0.0,
                recurrent_ms: 0.0,
                lif_ms: 0.0,
                readout_ms: 0.0,
            };
            world.flies.lock().unwrap().insert(
                fly_id,
                Arc::new(Mutex::new(WorldFlyRuntime {
                    sim,
                    fly,
                    rates_by_id: HashMap::new(),
                    snapshot: snapshot.clone(),
                    fly_time_left_sec: WORLD_FLY_TIME_MAX_SEC,
                    wander_heading_rad: p.fly.heading,
                    wander_time_left_sec: WORLD_WANDER_INTERVAL_SEC,
                    feeding_source_id: None,
                    feeding_time_left_sec: 0.0,
                    rng_state: (fly_id as u64).wrapping_mul(0x9E3779B97F4A7C15u64).wrapping_add(1),
                })),
            );
            world
                .snapshots
                .lock()
                .unwrap()
                .insert(fly_id, snapshot.clone());
            serde_json::to_string(&serde_json::json!({
                "ok": true,
                "fly_id": fly_id,
                "fly": snapshot.fly,
            }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "world runtime not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"world_remove_fly\"") || line.contains("\"method\": \"world_remove_fly\"")
    {
        if let Some(ref world) = world_runtime {
            let v: serde_json::Value = serde_json::from_str(line)?;
            let p: WorldRemoveFlyParams = serde_json::from_value(v["params"].clone())?;
            let removed = world.flies.lock().unwrap().remove(&p.fly_id).is_some();
            world.snapshots.lock().unwrap().remove(&p.fly_id);
            serde_json::to_string(&serde_json::json!({
                "ok": removed,
                "fly_id": p.fly_id,
            }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "world runtime not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"world_set_rates\"") || line.contains("\"method\": \"world_set_rates\"")
    {
        if let Some(ref world) = world_runtime {
            let v: serde_json::Value = serde_json::from_str(line)?;
            let p: WorldSetRatesParams = serde_json::from_value(v["params"].clone())?;
            let runtime_handle = {
                let flies = world.flies.lock().unwrap();
                flies.get(&p.fly_id).cloned()
            };
            if let Some(runtime_handle) = runtime_handle {
                let mut runtime = runtime_handle.lock().unwrap();
                runtime.rates_by_id = p
                    .rates_by_id
                    .into_iter()
                    .filter(|(_, hz)| hz.is_finite() && *hz > 0.0)
                    .collect();
                serde_json::to_string(&serde_json::json!({
                    "ok": true,
                    "fly_id": p.fly_id,
                    "rates_len": runtime.rates_by_id.len(),
                }))?
            } else {
                serde_json::to_string(&ErrResp {
                    error: format!("fly {} not found", p.fly_id),
                })?
            }
        } else {
            serde_json::to_string(&ErrResp {
                error: "world runtime not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"world_set_sources\"") || line.contains("\"method\": \"world_set_sources\"")
    {
        if let Some(ref world) = world_runtime {
            let v: serde_json::Value = serde_json::from_str(line)?;
            let p: WorldSetSourcesParams = serde_json::from_value(v["params"].clone())?;
            let srcs: Vec<SourceInput> = p
                .sources
                .into_iter()
                .map(|x| SourceInput {
                    id: x.id,
                    x: x.x,
                    y: x.y,
                    radius: x.radius,
                })
                .collect();
            *world.sources.lock().unwrap() = srcs;
            serde_json::to_string(&serde_json::json!({
                "ok": true
            }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "world runtime not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"world_get_snapshot\"") || line.contains("\"method\": \"world_get_snapshot\"")
    {
        if let Some(ref world) = world_runtime {
            let tick = world.tick.load(Ordering::Acquire);
            let flies: Vec<WorldSnapshotFly> = world
                .snapshots
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect();
            serde_json::to_string(&WorldSnapshotResp {
                ok: true,
                tick,
                dt_sec: world.dt_sec,
                flies,
            })?
        } else {
            serde_json::to_string(&ErrResp {
                error: "world runtime not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"world_read_ticks\"")
        || line.contains("\"method\": \"world_read_ticks\"")
    {
        if let Some(ref world) = world_runtime {
            let v: serde_json::Value = serde_json::from_str(line)?;
            let p: WorldReadTicksParams = serde_json::from_value(
                v.get("params")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            )?;
            let after = p.after_tick;
            let max_ticks = p.max_ticks.clamp(1, 8000);
            let mut ticks: Vec<WorldTickRecord> = {
                let buf = world.ticks.lock().unwrap();
                let mut out = Vec::new();
                for rec in buf.iter().rev() {
                    if rec.tick <= after {
                        break;
                    }
                    out.push(rec.clone());
                    if out.len() >= max_ticks {
                        break;
                    }
                }
                out
            };
            ticks.reverse();
            serde_json::to_string(&serde_json::json!({
                "ticks": ticks,
                "latest_tick": world.tick.load(Ordering::Acquire),
                "dt_sec": world.dt_sec,
            }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "world runtime not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"world_pause\"") || line.contains("\"method\": \"world_pause\"")
    {
        if let Some(ref world) = world_runtime {
            world.paused.store(1, Ordering::Release);
            serde_json::to_string(&serde_json::json!({ "ok": true }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "world runtime not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"world_resume\"") || line.contains("\"method\": \"world_resume\"")
    {
        if let Some(ref world) = world_runtime {
            world.paused.store(0, Ordering::Release);
            serde_json::to_string(&serde_json::json!({ "ok": true }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "world runtime not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"live_set_pen_a\"") || line.contains("\"method\": \"live_set_pen_a\"")
    {
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p = v.get("params").cloned().unwrap_or_default();
        let left = p
            .get("left_hz")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0)
            .clamp(0.0, 500.0);
        let right = p
            .get("right_hz")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0)
            .clamp(0.0, 500.0);
        if let Some(ref clive) = continuous_live {
            let mut custom: HashMap<String, f64> = HashMap::new();
            if let Some(obj) = p.get("rates_by_id").and_then(|x| x.as_object()) {
                for (k, v) in obj {
                    if let Some(hz) = v.as_f64() {
                        let hz = hz.clamp(0.0, 500.0);
                        if hz > 0.0 {
                            custom.insert(k.clone(), hz);
                        }
                    }
                }
            }
            {
                let mut guard = clive.custom_rates.lock().unwrap();
                *guard = if custom.is_empty() {
                    None
                } else {
                    Some(custom)
                };
            }
            clive
                .pen_left_hz_bits
                .store(left.to_bits(), Ordering::Release);
            clive
                .pen_right_hz_bits
                .store(right.to_bits(), Ordering::Release);
            serde_json::to_string(&serde_json::json!({
                "ok": true,
                "left_hz": left,
                "right_hz": right,
            }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "continuous live sim not available (classification.csv / PEN_a)".into(),
            })?
        }
    } else if line.contains("\"method\":\"live_read_ticks\"")
        || line.contains("\"method\": \"live_read_ticks\"")
    {
        let v: serde_json::Value = serde_json::from_str(line)?;
        let p = v.get("params").cloned().unwrap_or_default();
        let after = p
            .get("after_tick")
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as u32;
        let max_ticks = p
            .get("max_ticks")
            .and_then(|x| x.as_u64())
            .unwrap_or(800)
            .clamp(1, 8000) as usize;
        if let Some(ref clive) = continuous_live {
            let mut ticks: Vec<LiveTickRecord> = {
                let buf = clive.tick_buffer.lock().unwrap();
                let mut out = Vec::new();
                for rec in buf.iter().rev() {
                    if rec.tick <= after { break; }
                    out.push(rec.clone());
                    if out.len() >= max_ticks { break; }
                }
                out
            };
            ticks.reverse();
            let latest = clive.latest_tick.load(Ordering::Acquire);
            serde_json::to_string(&serde_json::json!({
                "ticks": ticks,
                "latest_tick": latest,
                "dt_sec": clive.dt_sec,
            }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "continuous live sim not available".into(),
            })?
        }
    } else if line.contains("\"method\":\"live_status\"") || line.contains("\"method\": \"live_status\"")
    {
        if let Some(ref clive) = continuous_live {
            let left = f64::from_bits(clive.pen_left_hz_bits.load(Ordering::Relaxed));
            let right = f64::from_bits(clive.pen_right_hz_bits.load(Ordering::Relaxed));
            let rates_by_id = clive.custom_rates.lock().unwrap().clone();
            serde_json::to_string(&serde_json::json!({
                "ok": true,
                "latest_tick": clive.latest_tick.load(Ordering::Acquire),
                "left_hz": left,
                "right_hz": right,
                "dt_sec": clive.dt_sec,
                "rates_by_id": rates_by_id,
            }))?
        } else {
            serde_json::to_string(&ErrResp {
                error: "continuous live sim not available".into(),
            })?
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
