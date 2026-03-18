//! One-off binary: load connectome + classification, report PEN_a -> X and ER (ring) -> EPG connectivity.
//! Uses single connectome: data/raw/2025_Connectivity_783.parquet (no env overrides).

use brain_sim_service::connectome;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(serde::Deserialize)]
struct EpgTileEntry {
    root_id: String,
    #[serde(rename = "tile_index_0_7")]
    tile_index_0_7: u8,
    #[serde(default)]
    side: String,
}
#[derive(serde::Deserialize)]
struct EpgTileMap {
    entries: Vec<EpgTileEntry>,
}

/// 16-bin order matching frontend EPG_SLICE_ORDER_CLOCKWISE: L5,R4,L6,R3,L7,R2,L8,R1, L1,R8,L2,R7,L3,R6,L4,R5.
/// (side, tile_index_0_7) -> bin index 0..15.
fn epg_side_tile_to_bin_16(side: &str, tile: u8) -> Option<u8> {
    if tile > 7 {
        return None;
    }
    let t = tile as usize;
    let is_left = side.eq_ignore_ascii_case("left");
    let is_right = side.eq_ignore_ascii_case("right");
    if !is_left && !is_right {
        return None;
    }
    // Order: L5,R4,L6,R3,L7,R2,L8,R1, L1,R8,L2,R7,L3,R6,L4,R5
    // (L,4)->0, (R,3)->1, (L,5)->2, (R,2)->3, (L,6)->4, (R,1)->5, (L,7)->6, (R,0)->7,
    // (L,0)->8, (R,7)->9, (L,1)->10, (R,6)->11, (L,2)->12, (R,5)->13, (L,3)->14, (R,4)->15
    let bin = if is_left {
        [8, 10, 12, 14, 0, 2, 4, 6][t]
    } else {
        [7, 5, 3, 1, 15, 13, 11, 9][t]
    };
    Some(bin as u8)
}

const EPG_16_BIN_LABELS: [&str; 16] = [
    "L5", "R4", "L6", "R3", "L7", "R2", "L8", "R1",
    "L1", "R8", "L2", "R7", "L3", "R6", "L4", "R5",
];

#[derive(Default)]
struct ErToEpgStats {
    exc_count: u64,
    inh_count: u64,
    exc_weight: f64,
    inh_weight: f64,
}

#[derive(Default)]
struct PenAToErStats {
    left_n: u64,
    left_wt: f64,
    right_n: u64,
    right_wt: f64,
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("repo layout: api/brain-sim-service under repo root");
    let connectome_path = repo_root.join("data/raw/2025_Connectivity_783.parquet");
    let classification_path = repo_root.join("data/raw/classification.csv");
    if !connectome_path.exists() {
        return Err(format!("Connectome not found: {}", connectome_path.display()).into());
    }
    if !classification_path.exists() {
        return Err(format!("Classification not found: {}", classification_path.display()).into());
    }
    eprintln!("Connectome: {}", connectome_path.display());
    eprintln!("Classification: {}", classification_path.display());

    let template = connectome::load_connectome(&connectome_path)?;
    let neuron_ids = &template.neuron_ids;
    let _id_to_idx: HashMap<&str, u32> = neuron_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i as u32))
        .collect();

    let (pen_a, epg, er) = load_classification_sets(&classification_path)?;
    let (pen_a_left, pen_a_right) = load_pen_a_by_side(&classification_path)?;
    let er_type_by_id = load_er_type_by_id(&classification_path)?;
    let epg_side_tile = load_epg_side_tile_map(Some(repo_root), &classification_path)?;
    let (delta7, delta7_left, delta7_right) = load_delta7_and_side(&classification_path)?;
    println!("Classification: PEN_a={} (left={} right={}) EPG={} ER(ring)={} Delta7={} (left={} right={}) epg_side_tile_entries={}", pen_a.len(), pen_a_left.len(), pen_a_right.len(), epg.len(), er.len(), delta7.len(), delta7_left.len(), delta7_right.len(), epg_side_tile.len());

    // PEN_a -> ? (post targets by type), and by left vs right; and PEN_a left/right -> EPG by tile
    let mut pen_a_to_er = 0u64;
    let mut pen_a_to_epg = 0u64;
    let mut pen_a_to_other = 0u64;
    let mut pen_a_out_edges: u64 = 0;
    let mut pen_a_to_er_weight: f64 = 0.0;
    let mut pen_a_to_epg_weight: f64 = 0.0;
    let mut left_to_er = 0u64;
    let mut left_to_epg = 0u64;
    let mut left_to_other = 0u64;
    let mut left_to_er_w: f64 = 0.0;
    let mut left_to_epg_w: f64 = 0.0;
    let mut right_to_er = 0u64;
    let mut right_to_epg = 0u64;
    let mut right_to_other = 0u64;
    let mut right_to_er_w: f64 = 0.0;
    let mut right_to_epg_w: f64 = 0.0;

    // PEN_a left/right -> EPG by tile (0..8)
    let mut left_to_tile_n: [u64; 8] = [0; 8];
    let mut left_to_tile_w: [f64; 8] = [0.0; 8];
    let mut right_to_tile_n: [u64; 8] = [0; 8];
    let mut right_to_tile_w: [f64; 8] = [0.0; 8];

    // Per-bin report (16 bins L1-L8, R1-R8): which PEN_a neurons are strongest for each bin?
    // Key: (pen_a_root_id, bin_index_0_15) -> (syn_count, total_weight)
    let mut pen_a_to_bin: HashMap<(String, u8), (u64, f64)> = HashMap::new();

    // PEN_a left/right -> ER by ER type (ER1, ER2, ER3a, ...)
    let mut pen_a_to_er_by_type: HashMap<String, PenAToErStats> = HashMap::new();

    // Upstream of Delta7: PEN_a left/right -> Delta7, EPG -> Delta7
    let mut left_to_delta7_n: u64 = 0;
    let mut left_to_delta7_w: f64 = 0.0;
    let mut right_to_delta7_n: u64 = 0;
    let mut right_to_delta7_w: f64 = 0.0;
    let mut epg_to_delta7_n: u64 = 0;
    let mut epg_to_delta7_w: f64 = 0.0;

    // ER (ring) -> EPG (count and sign), and per ER subtype
    let mut er_to_epg_excitatory = 0u64;
    let mut er_to_epg_inhibitory = 0u64;
    let mut er_to_epg_exc_weight: f64 = 0.0;
    let mut er_to_epg_inh_weight: f64 = 0.0;
    let mut er_type_stats: HashMap<String, ErToEpgStats> = HashMap::new();

    for e in 0..template.edges_pre.len() {
        let pre_idx = template.edges_pre[e] as usize;
        let post_idx = template.edges_post[e] as usize;
        let w = template.edges_weight[e] as f64;
        let pre_id = neuron_ids.get(pre_idx).map(String::as_str).unwrap_or("");
        let post_id = neuron_ids.get(post_idx).map(String::as_str).unwrap_or("");

        if pen_a.contains(pre_id) {
            pen_a_out_edges += 1;
            let is_left = pen_a_left.contains(pre_id);
            let is_right = pen_a_right.contains(pre_id);
            if er.contains(post_id) {
                pen_a_to_er += 1;
                pen_a_to_er_weight += w;
                if is_left { left_to_er += 1; left_to_er_w += w; }
                if is_right { right_to_er += 1; right_to_er_w += w; }
                let er_typ = er_type_by_id.get(post_id).map(String::as_str).unwrap_or("ER?");
                let st = pen_a_to_er_by_type.entry(er_typ.to_string()).or_default();
                if is_left { st.left_n += 1; st.left_wt += w; }
                if is_right { st.right_n += 1; st.right_wt += w; }
            } else if epg.contains(post_id) {
                pen_a_to_epg += 1;
                pen_a_to_epg_weight += w;
                if is_left { left_to_epg += 1; left_to_epg_w += w; }
                if is_right { right_to_epg += 1; right_to_epg_w += w; }
                if let Some((epg_side, tile)) = epg_side_tile.get(post_id) {
                    let t = (*tile as usize).min(7);
                    if is_left { left_to_tile_n[t] += 1; left_to_tile_w[t] += w; }
                    if is_right { right_to_tile_n[t] += 1; right_to_tile_w[t] += w; }
                    if let Some(bin16) = epg_side_tile_to_bin_16(epg_side.as_str(), *tile) {
                        let key = (pre_id.to_string(), bin16);
                        let entry = pen_a_to_bin.entry(key).or_insert((0, 0.0));
                        entry.0 += 1;
                        entry.1 += w;
                    }
                }
            } else if delta7.contains(post_id) {
                if is_left { left_to_delta7_n += 1; left_to_delta7_w += w; }
                if is_right { right_to_delta7_n += 1; right_to_delta7_w += w; }
            } else {
                pen_a_to_other += 1;
                if is_left { left_to_other += 1; }
                if is_right { right_to_other += 1; }
            }
        }

        if epg.contains(pre_id) && delta7.contains(post_id) {
            epg_to_delta7_n += 1;
            epg_to_delta7_w += w;
        }

        if er.contains(pre_id) && epg.contains(post_id) {
            let typ = er_type_by_id.get(pre_id).map(String::as_str).unwrap_or("ER?");
            let st = er_type_stats.entry(typ.to_string()).or_default();
            if w >= 0.0 {
                er_to_epg_excitatory += 1;
                er_to_epg_exc_weight += w;
                st.exc_count += 1;
                st.exc_weight += w;
            } else {
                er_to_epg_inhibitory += 1;
                er_to_epg_inh_weight += w;
                st.inh_count += 1;
                st.inh_weight += w;
            }
        }
    }

    println!("\n--- PEN_a outgoing connections ---");
    println!("  PEN_a -> ER (ring):  {} synapses (total weight {:.2})", pen_a_to_er, pen_a_to_er_weight);
    println!("  PEN_a -> EPG:        {} synapses (total weight {:.2})", pen_a_to_epg, pen_a_to_epg_weight);
    println!("  PEN_a -> other:      {} synapses", pen_a_to_other);
    println!("  PEN_a total out:     {} edges", pen_a_out_edges);
    println!("\n--- PEN_a LEFT vs RIGHT (weights to ER and EPG) ---");
    println!("  {:8} | {:>8} | {:>10} | {:>8} | {:>10} | {:>8}", "side", "->ER n", "->ER wt", "->EPG n", "->EPG wt", "->other");
    println!("  {} | {} | {} | {} | {} | {}", "-".repeat(8), "-".repeat(8), "-".repeat(10), "-".repeat(8), "-".repeat(10), "-".repeat(8));
    println!("  {:8} | {:>8} | {:>10.1} | {:>8} | {:>10.1} | {:>8}", "left", left_to_er, left_to_er_w, left_to_epg, left_to_epg_w, left_to_other);
    println!("  {:8} | {:>8} | {:>10.1} | {:>8} | {:>10.1} | {:>8}", "right", right_to_er, right_to_er_w, right_to_epg, right_to_epg_w, right_to_other);

    println!("\n--- PEN_a LEFT vs RIGHT -> EPG by tile (bin 0..7) ---");
    println!("  {:6} | {:>10} | {:>10} | {:>10} | {:>10}", "tile", "L_n", "L_wt", "R_n", "R_wt");
    println!("  {} | {} | {} | {} | {}", "-".repeat(6), "-".repeat(10), "-".repeat(10), "-".repeat(10), "-".repeat(10));
    for t in 0..8 {
        println!(
            "  {:6} | {:>10} | {:>10.1} | {:>10} | {:>10.1}",
            t,
            left_to_tile_n[t],
            left_to_tile_w[t],
            right_to_tile_n[t],
            right_to_tile_w[t]
        );
    }

    // Per-bin (16 bins: L5,R4,L6,R3,L7,R2,L8,R1, L1,R8,L2,R7,L3,R6,L4,R5): strongest PEN_a per bin
    println!("\n--- Strongest PEN_a neurons per EB bin (16 bins: L1–L8, R1–R8) ---");
    println!("  For each bin, PEN_a neurons ranked by total weight to EPG in that bin.");
    println!("  Stimulate these PEN_a neurons to drive the bump toward that wedge.\n");
    for bin in 0u8..16 {
        let label = EPG_16_BIN_LABELS[bin as usize];
        let mut entries: Vec<_> = pen_a_to_bin
            .iter()
            .filter(|((_, b), _)| *b == bin)
            .map(|((pen_id, _), &(n, w))| (pen_id.clone(), n, w))
            .collect();
        entries.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
        let side = |id: &str| -> &'static str {
            if pen_a_left.contains(id) {
                "L"
            } else if pen_a_right.contains(id) {
                "R"
            } else {
                "?"
            }
        };
        println!("  Bin {:2} ({})", bin, label);
        if entries.is_empty() {
            println!("    (no PEN_a -> EPG in this bin)");
        } else {
            for (i, (pen_id, syn_count, weight)) in entries.iter().enumerate().take(15) {
                println!(
                    "    {:2}. {} {}  weight={:.1}  syn_count={}",
                    i + 1,
                    pen_id,
                    side(pen_id),
                    weight,
                    syn_count
                );
            }
            if entries.len() > 15 {
                println!("    ... and {} more", entries.len() - 15);
            }
        }
        println!();
    }

    println!("\n--- PEN_a LEFT vs RIGHT -> ER (by ER type) ---");
    println!("  {:10} | {:>8} | {:>10} | {:>8} | {:>10}", "ER type", "L_n", "L_wt", "R_n", "R_wt");
    println!("  {} | {} | {} | {} | {}", "-".repeat(10), "-".repeat(8), "-".repeat(10), "-".repeat(8), "-".repeat(10));
    let mut er_types: Vec<_> = pen_a_to_er_by_type.into_iter().collect();
    er_types.sort_by(|a, b| {
        let ta = a.1.left_n + a.1.right_n;
        let tb = b.1.left_n + b.1.right_n;
        tb.cmp(&ta).then_with(|| a.0.cmp(&b.0))
    });
    for (typ, st) in &er_types {
        if st.left_n == 0 && st.right_n == 0 {
            continue;
        }
        println!(
            "  {:10} | {:>8} | {:>10.1} | {:>8} | {:>10.1}",
            typ,
            st.left_n,
            st.left_wt,
            st.right_n,
            st.right_wt
        );
    }

    // Interpret: which ER types are net inhibitory to EPG? Right PEN_a sends more to them.
    let mut left_to_inh_er_n: u64 = 0;
    let mut right_to_inh_er_n: u64 = 0;
    let mut left_to_inh_er_w: f64 = 0.0;
    let mut right_to_inh_er_w: f64 = 0.0;
    let mut inh_er_types: Vec<&str> = Vec::new();
    for (typ, st) in &er_types {
        let epg_st = er_type_stats.get(typ);
        let is_inhibitory = epg_st.map(|s| s.inh_count > s.exc_count).unwrap_or(false);
        if is_inhibitory {
            left_to_inh_er_n += st.left_n;
            right_to_inh_er_n += st.right_n;
            left_to_inh_er_w += st.left_wt;
            right_to_inh_er_w += st.right_wt;
            inh_er_types.push(typ.as_str());
        }
    }
    println!("\n--- Why left PEN_a moves bump but right PEN_a doesn't? ---");
    println!("  ER types that are predominantly inhibitory to EPG: {:?}", inh_er_types);
    println!("  PEN_a -> those inhibitory ER:  left {} syn ({:.1} wt)  right {} syn ({:.1} wt)", left_to_inh_er_n, left_to_inh_er_w, right_to_inh_er_n, right_to_inh_er_w);
    println!("  PEN_a -> EPG (direct):        left {} syn ({:.1} wt)  right {} syn ({:.1} wt)", left_to_epg, left_to_epg_w, right_to_epg, right_to_epg_w);
    let left_ratio = if left_to_inh_er_n > 0 { left_to_epg_w / left_to_inh_er_w } else { f64::MAX };
    let right_ratio = if right_to_inh_er_n > 0 { right_to_epg_w / right_to_inh_er_w } else { f64::MAX };
    println!("  Ratio (EPG wt / inhibitory-ER wt): left {:.2}  right {:.2}", left_ratio, right_ratio);
    let right_heavy: Vec<_> = er_types.iter().filter(|(_, st)| st.right_n > st.left_n).map(|(t, st)| format!("{} (R{} L{})", t, st.right_n, st.left_n)).collect();
    println!("  ER types where RIGHT PEN_a has more synapses than left: {:?}", right_heavy);
    let right_heavy_total = right_heavy.len();
    let right_heavy_inh = er_types
        .iter()
        .filter(|(typ, st)| st.right_n > st.left_n && inh_er_types.iter().any(|t| t == &typ.as_str()))
        .count();
    let right_heavy_inh_ratio = if right_heavy_total > 0 {
        right_heavy_inh as f64 / right_heavy_total as f64
    } else {
        0.0
    };
    println!(
        "  RIGHT-heavy ER types that are inhibitory-to-EPG: {}/{} ({:.1}%)",
        right_heavy_inh,
        right_heavy_total,
        right_heavy_inh_ratio * 100.0
    );
    if right_heavy_total > 0 {
        let label = if right_heavy_inh_ratio >= 0.6 {
            "majority"
        } else if right_heavy_inh_ratio <= 0.4 {
            "minority"
        } else {
            "mixed"
        };
        println!(
            "  Data-driven interpretation: inhibitory ER presence among RIGHT-heavy types is {}.",
            label
        );
    }

    println!("\n--- Upstream of Delta7 (downstream of EPG/compass) ---");
    println!("  PEN_a left  -> Delta7: {} synapses (total weight {:.1})", left_to_delta7_n, left_to_delta7_w);
    println!("  PEN_a right -> Delta7: {} synapses (total weight {:.1})", right_to_delta7_n, right_to_delta7_w);
    println!("  EPG         -> Delta7: {} synapses (total weight {:.1})", epg_to_delta7_n, epg_to_delta7_w);
    if delta7_left.len() > 0 || delta7_right.len() > 0 {
        println!("  Delta7 side: left={} right={}", delta7_left.len(), delta7_right.len());
    }

    println!("\n--- ER (ring) -> EPG connections ---");
    println!("  ER -> EPG excitatory:  {} synapses (total weight {:.2})", er_to_epg_excitatory, er_to_epg_exc_weight);
    println!("  ER -> EPG inhibitory:  {} synapses (total weight {:.2})", er_to_epg_inhibitory, er_to_epg_inh_weight);
    println!("  ER -> EPG total:       {} synapses", er_to_epg_excitatory + er_to_epg_inhibitory);

    // Per-ER-type breakdown (ER1, ER2, ER3a, ...)
    let mut types: Vec<_> = er_type_stats.into_iter().collect();
    types.sort_by(|a, b| {
        let total_a = a.1.exc_count + a.1.inh_count;
        let total_b = b.1.exc_count + b.1.inh_count;
        total_b.cmp(&total_a).then_with(|| a.0.cmp(&b.0))
    });
    println!("\n--- ER type -> EPG (by subtype) ---");
    println!("  {:12} | {:>8} | {:>8} | {:>10} | {:>10} | {:>8}", "ER type", "exc_n", "inh_n", "exc_wt", "inh_wt", "total");
    println!("  {} | {} | {} | {} | {} | {}", "-".repeat(12), "-".repeat(8), "-".repeat(8), "-".repeat(10), "-".repeat(10), "-".repeat(8));
    for (typ, st) in &types {
        let total = st.exc_count + st.inh_count;
        if total == 0 {
            continue;
        }
        println!(
            "  {:12} | {:>8} | {:>8} | {:>10.1} | {:>10.1} | {:>8}",
            typ,
            st.exc_count,
            st.inh_count,
            st.exc_weight,
            st.inh_weight,
            total
        );
    }

    Ok(())
}

fn load_classification_sets(path: &Path) -> Result<(HashSet<String>, HashSet<String>, HashSet<String>), Box<dyn std::error::Error + Send + Sync>> {
    let mut pen_a = HashSet::new();
    let mut epg = HashSet::new();
    let mut er = HashSet::new();
    let mut rdr = csv::Reader::from_path(path)?;
    let headers = rdr.headers()?.clone();
    let root_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("root_id")).unwrap_or(0);
    let hemibrain_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("hemibrain_type")).unwrap_or(6);
    for row in rdr.records() {
        let row = row?;
        let root_id = row.get(root_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        if root_id.is_empty() {
            continue;
        }
        let hemibrain = row.get(hemibrain_idx).map(|s| s.trim()).unwrap_or("");
        if hemibrain.starts_with("PEN_a") {
            pen_a.insert(root_id);
        } else if hemibrain.contains("EPG") && hemibrain != "EPGt" {
            epg.insert(root_id);
        } else if hemibrain.starts_with("ER") {
            er.insert(root_id);
        }
    }
    Ok((pen_a, epg, er))
}

/// Load EPG root_id -> (side, tile_index_0_7) from data/epg-tile-map.json for 16-bin (L1–L8, R1–R8) mapping.
fn load_epg_side_tile_map(repo_root: Option<&Path>, classification_path: &Path) -> Result<HashMap<String, (String, u8)>, Box<dyn std::error::Error + Send + Sync>> {
    let candidates: Vec<_> = repo_root
        .map(|r| r.join("data/epg-tile-map.json"))
        .into_iter()
        .chain(classification_path.parent().and_then(|p| p.parent()).map(|p| p.join("epg-tile-map.json")))
        .chain(classification_path.parent().map(|p| p.join("epg-tile-map.json")))
        .collect();
    let path = candidates.into_iter().find(|p| p.exists()).ok_or_else(|| "epg-tile-map.json not found")?;
    let s = std::fs::read_to_string(&path)?;
    let map: EpgTileMap = serde_json::from_str(&s)?;
    let out: HashMap<String, (String, u8)> = map
        .entries
        .into_iter()
        .map(|e| (e.root_id, (e.side.trim().to_lowercase(), e.tile_index_0_7)))
        .collect();
    Ok(out)
}

/// Load Delta7 root_id set and left/right split from classification.csv (hemibrain_type or cell_type contains "Delta7").
fn load_delta7_and_side(path: &Path) -> Result<(HashSet<String>, HashSet<String>, HashSet<String>), Box<dyn std::error::Error + Send + Sync>> {
    let mut delta7 = HashSet::new();
    let mut left = HashSet::new();
    let mut right = HashSet::new();
    let mut rdr = csv::Reader::from_path(path)?;
    let headers = rdr.headers()?.clone();
    let root_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("root_id")).unwrap_or(0);
    let hemibrain_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("hemibrain_type")).unwrap_or(6);
    let cell_type_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("cell_type"));
    let side_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("side")).unwrap_or(8);
    for row in rdr.records() {
        let row = row?;
        let root_id = row.get(root_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        if root_id.is_empty() {
            continue;
        }
        let hemibrain = row.get(hemibrain_idx).map(|s| s.trim()).unwrap_or("");
        let cell_type = cell_type_idx.and_then(|i| row.get(i)).map(|s| s.trim()).unwrap_or("");
        let is_delta7 = hemibrain.to_lowercase().contains("delta7")
            || cell_type.to_lowercase().contains("delta7");
        if !is_delta7 {
            continue;
        }
        delta7.insert(root_id.clone());
        let side = row.get(side_idx).map(|s| s.trim().to_lowercase()).unwrap_or_default();
        if side == "left" {
            left.insert(root_id);
        } else if side == "right" {
            right.insert(root_id);
        }
    }
    Ok((delta7, left, right))
}

/// Load PEN_a root_ids split by side (left, right) from classification.csv.
fn load_pen_a_by_side(path: &Path) -> Result<(HashSet<String>, HashSet<String>), Box<dyn std::error::Error + Send + Sync>> {
    let mut left = HashSet::new();
    let mut right = HashSet::new();
    let mut rdr = csv::Reader::from_path(path)?;
    let headers = rdr.headers()?.clone();
    let root_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("root_id")).unwrap_or(0);
    let hemibrain_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("hemibrain_type")).unwrap_or(6);
    let side_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("side")).unwrap_or(8);
    for row in rdr.records() {
        let row = row?;
        let root_id = row.get(root_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        let hemibrain = row.get(hemibrain_idx).map(|s| s.trim()).unwrap_or("");
        let side = row.get(side_idx).map(|s| s.trim().to_lowercase()).unwrap_or_default();
        if root_id.is_empty() || !hemibrain.starts_with("PEN_a") {
            continue;
        }
        if side == "left" {
            left.insert(root_id);
        } else if side == "right" {
            right.insert(root_id);
        }
    }
    Ok((left, right))
}

/// Load map root_id -> hemibrain_type for all neurons whose hemibrain_type starts with "ER".
fn load_er_type_by_id(path: &Path) -> Result<HashMap<String, String>, Box<dyn std::error::Error + Send + Sync>> {
    let mut out = HashMap::new();
    let mut rdr = csv::Reader::from_path(path)?;
    let headers = rdr.headers()?.clone();
    let root_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("root_id")).unwrap_or(0);
    let hemibrain_idx = headers.iter().position(|h| h.trim().eq_ignore_ascii_case("hemibrain_type")).unwrap_or(6);
    for row in rdr.records() {
        let row = row?;
        let root_id = row.get(root_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        let hemibrain = row.get(hemibrain_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        if root_id.is_empty() || !hemibrain.starts_with("ER") {
            continue;
        }
        out.insert(root_id, hemibrain);
    }
    Ok(out)
}
