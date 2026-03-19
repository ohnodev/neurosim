//! Spike-based LIF simulation logic (CPU + optional GPU).
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::connectome::ConnectomeTemplate;

use crate::model_constants::{
    EPG_RECURRENCE_BOOST, REFRACT_MS, TAU_MEM_MS, TAU_SYN_MS, V_RESET, V_REST, V_THRESH, W_SYN,
};

const SENSORY_POISSON_SCALE: f32 = 250.0;
const ACTIVITY_THRESHOLD: u8 = 1;
const SYNAPTIC_DELAY_MS: f32 = 1.8;

pub struct BrainSim {
    /// Shared connectome (loaded once at startup). Never cloned per sim.
    template: Arc<ConnectomeTemplate>,
    n: usize,
    w_syn: f32,
    epg_recurrence_boost: f32,
    v: Vec<f32>,
    g: Vec<f32>,
    g_next: Vec<f32>,
    syn_input: Vec<f32>,
    delay_buffer: Vec<f32>,
    delay_head: usize,
    delay_len: usize,
    refractory: Vec<u16>,
    spikes: Vec<u8>,
    epg_indices: Vec<u32>,
    max_activity_entries: usize,
    rng_state: u64,
    stim_log_every: u64,
    step_counter: u64,
    olf_poisson_total: u64,
    forced_spikes_total: u64,
    network_spikes_total: u64,
    /// Pre-resolved world stim presets: preset name -> (neuron_idx, rate_hz).
    world_stim_presets: HashMap<String, Vec<(u32, f32)>>,
    #[cfg(feature = "cuda")]
    gpu: Option<crate::gpu::GpuSimState>,
}

pub struct FlyInput {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub heading: f64,
    pub t: f64,
    pub hunger: f64,
    pub health: f64,
    pub rest_time_left: f64,
    pub dead: bool,
}

#[derive(Clone)]
pub struct SourceInput {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub radius: f64,
}

pub struct StepTiming {
    pub compute_ms: f64,
    pub kernel_ms: f64,
    pub recurrent_ms: f64,
    pub lif_ms: f64,
    pub readout_ms: f64,
}

pub struct FlyStepOutput {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub heading: f64,
    pub t: f64,
    pub hunger: f64,
    pub health: f64,
    pub dead: bool,
    pub fly_time_left: f64,
    pub rest_time_left: f64,
    pub rest_duration: f64,
    pub feeding: bool,
    pub eaten_food_id: Option<String>,
    pub feeding_candidate_id: Option<String>,
    pub feeding_sugar_taken: f64,
}

impl BrainSim {
    /// Choose 11PM/3PM/8PM preset from fly heading vs nearest source. Public for world loop.
    pub fn choose_world_preset_for_fly(fly: &FlyInput, sources: &[SourceInput]) -> &'static str {
        let heading_deg = fly.heading.to_degrees();
        let mut target_deg = heading_deg;
        let mut nearest_d2 = f64::INFINITY;
        for s in sources {
            let dx = s.x - fly.x;
            let dy = s.y - fly.y;
            let d2 = dx * dx + dy * dy;
            if d2 < nearest_d2 {
                nearest_d2 = d2;
                target_deg = dy.atan2(dx).to_degrees();
            }
        }
        let mut delta = target_deg - heading_deg;
        while delta > 180.0 {
            delta -= 360.0;
        }
        while delta < -180.0 {
            delta += 360.0;
        }
        // Three-way coarse turn controller:
        // - 11PM: keep current heading (small error)
        // - 3PM: step toward positive/CCW target error
        // - 8PM: step toward negative/CW target error
        const TURN_DEADBAND_DEG: f64 = 20.0;
        if delta > TURN_DEADBAND_DEG {
            "3PM"
        } else if delta < -TURN_DEADBAND_DEG {
            "8PM"
        } else {
            "11PM"
        }
    }

    pub fn set_rng_seed(&mut self, seed: u64) {
        self.rng_state = seed;
    }

    /// Return compact EPG spike indices (0..n_epg) for neurons that spiked this step.
    /// Frontend can derive bump angle from these using same formula as compute_bump_and_epg_bins.
    pub fn epg_spike_indices(&self) -> Vec<usize> {
        self.epg_indices
            .iter()
            .enumerate()
            .filter_map(|(j, &idx)| {
                if (idx as usize) < self.spikes.len() && self.spikes[idx as usize] >= ACTIVITY_THRESHOLD {
                    Some(j)
                } else {
                    None
                }
            })
            .collect()
    }

    fn compute_synaptic_delay_steps(dt_sec: f64) -> usize {
        let dt_ms = dt_sec * 1000.0;
        if !dt_ms.is_finite() || dt_ms <= 0.0 {
            return 0;
        }
        ((SYNAPTIC_DELAY_MS as f64) / dt_ms).round().max(0.0) as usize
    }

    fn ensure_delay_queue_for_dt(&mut self, dt_sec: f64) {
        let delay_steps = Self::compute_synaptic_delay_steps(dt_sec);
        let desired_len = delay_steps.saturating_add(1);
        if self.delay_len == desired_len {
            return;
        }
        self.delay_len = desired_len;
        self.delay_head = 0;
        self.delay_buffer = vec![0.0f32; self.n * desired_len];
    }

    fn readout_activity_cap() -> usize {
        let parsed = std::env::var("NEUROSIM_ACTIVITY_CAP")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(10_000);
        parsed.max(1)
    }

    fn stim_log_interval() -> u64 {
        std::env::var("NEUROSIM_STIM_LOG_EVERY")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            // Quiet by default in production; set env var to re-enable periodic stim logs.
            .unwrap_or(0)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        neuron_ids: Vec<String>,
        edges_pre: Vec<u32>,
        edges_post: Vec<u32>,
        edges_weight: Vec<f32>,
        sensory_indices: Vec<u32>,
        sensory_left_indices: Vec<u32>,
        sensory_right_indices: Vec<u32>,
        sensory_unknown_indices: Vec<u32>,
        motor_left: Vec<u32>,
        motor_right: Vec<u32>,
        motor_unknown: Vec<u32>,
    ) -> Self {
        let (out_offsets, out_post, out_weight) =
            Self::build_csr_by_pre(neuron_ids.len(), &edges_pre, &edges_post, &edges_weight);
        Self::new_with_viewer(
            neuron_ids,
            edges_pre,
            edges_post,
            edges_weight,
            out_offsets,
            out_post,
            out_weight,
            W_SYN,
            EPG_RECURRENCE_BOOST,
            sensory_indices,
            sensory_left_indices,
            sensory_right_indices,
            sensory_unknown_indices,
            motor_left,
            motor_right,
            motor_unknown,
            Vec::new(),
        )
    }

    fn build_csr_by_pre(
        n: usize,
        edges_pre: &[u32],
        edges_post: &[u32],
        edges_weight: &[f32],
    ) -> (Vec<u32>, Vec<u32>, Vec<f32>) {
        let num_edges = edges_pre.len();
        if edges_post.len() != num_edges || edges_weight.len() != num_edges {
            panic!(
                "build_csr_by_pre: mismatched edge arrays (pre={}, post={}, weight={})",
                num_edges,
                edges_post.len(),
                edges_weight.len()
            );
        }
        let mut out_degree = vec![0u32; n];
        for &pre in edges_pre {
            if (pre as usize) < n {
                out_degree[pre as usize] += 1;
            }
        }
        let mut out_offsets = vec![0u32; n + 1];
        for i in 0..n {
            out_offsets[i + 1] = out_offsets[i] + out_degree[i];
        }
        let mut next_index = out_offsets.clone();
        let mut out_post = vec![0u32; num_edges];
        let mut out_weight = vec![0.0f32; num_edges];
        for e in 0..num_edges {
            let pre = edges_pre[e] as usize;
            if pre < n {
                let pos = next_index[pre] as usize;
                next_index[pre] += 1;
                out_post[pos] = edges_post[e];
                out_weight[pos] = edges_weight[e];
            }
        }
        (out_offsets, out_post, out_weight)
    }

    /// Create a sim from the shared connectome. Only allocates per-sim state (v, g, spikes, etc.); no connectome clone.
    pub fn from_template(
        template: Arc<ConnectomeTemplate>,
        w_syn: f32,
        epg_recurrence_boost: f32,
    ) -> Self {
        let n = template.neuron_ids.len();
        let epg_indices: Vec<u32> = template
            .is_epg
            .iter()
            .enumerate()
            .filter_map(|(i, &v)| if v > 0 { Some(i as u32) } else { None })
            .collect();
        let delay_len = Self::compute_synaptic_delay_steps(0.001).saturating_add(1);
        #[cfg(feature = "cuda")]
        let gpu = crate::gpu::get_gpu_connectome().and_then(|conn| {
            let v_init = vec![V_REST; n];
            let g_init = vec![0.0f32; n];
            let refrac_init = vec![0u16; n];
            let spikes_init = vec![0u8; n];
            let gs = crate::gpu::GpuSimState::new(
                n, conn, &v_init, &g_init, &refrac_init, &spikes_init, delay_len,
            );
            if gs.is_some() {
                eprintln!("[brain-service][gpu] sim state allocated on GPU (n={})", n);
            } else {
                eprintln!(
                    "[brain-service][gpu] sim state allocation failed; falling back to CPU (n={})",
                    n
                );
            }
            gs
        });
        Self {
            template,
            n,
            w_syn,
            epg_recurrence_boost,
            v: vec![V_REST; n],
            g: vec![0.0f32; n],
            g_next: vec![0.0f32; n],
            syn_input: vec![0.0f32; n],
            delay_buffer: vec![0.0f32; n * delay_len],
            delay_head: 0,
            delay_len,
            refractory: vec![0u16; n],
            spikes: vec![0u8; n],
            epg_indices,
            max_activity_entries: Self::readout_activity_cap(),
            rng_state: 0x9E3779B97F4A7C15u64,
            stim_log_every: Self::stim_log_interval(),
            step_counter: 0,
            olf_poisson_total: 0,
            forced_spikes_total: 0,
            network_spikes_total: 0,
            world_stim_presets: HashMap::new(),
            #[cfg(feature = "cuda")]
            gpu,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_viewer(
        neuron_ids: Vec<String>,
        edges_pre: Vec<u32>,
        edges_post: Vec<u32>,
        edges_weight: Vec<f32>,
        out_offsets: Vec<u32>,
        out_post: Vec<u32>,
        out_weight: Vec<f32>,
        w_syn: f32,
        epg_recurrence_boost: f32,
        sensory_indices: Vec<u32>,
        sensory_left_indices: Vec<u32>,
        sensory_right_indices: Vec<u32>,
        sensory_unknown_indices: Vec<u32>,
        motor_left: Vec<u32>,
        motor_right: Vec<u32>,
        motor_unknown: Vec<u32>,
        viewer_indices: Vec<u32>,
    ) -> Self {
        let n = neuron_ids.len();
        let neuron_index_by_id: HashMap<String, usize> = neuron_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), i))
            .collect();
        let mut sanitized_viewer: Vec<u32> = if viewer_indices.is_empty() {
            Vec::new()
        } else {
            viewer_indices
                .into_iter()
                .filter(|&i| (i as usize) < n)
                .collect()
        };
        sanitized_viewer.sort_unstable();
        sanitized_viewer.dedup();
        let mut is_epg = vec![0u8; n];
        for &idx in &sanitized_viewer {
            let i = idx as usize;
            if i < n {
                is_epg[i] = 1;
            }
        }
        let template = Arc::new(ConnectomeTemplate {
            neuron_ids,
            neuron_index_by_id,
            viewer_subset_indices: sanitized_viewer.clone(),
            is_epg,
            edges_pre,
            edges_post,
            edges_weight,
            out_offsets,
            out_post,
            out_weight,
            sensory_indices,
            sensory_left_indices,
            sensory_right_indices,
            sensory_unknown_indices,
            motor_left,
            motor_right,
            motor_unknown,
        });
        Self::from_template(template, w_syn, epg_recurrence_boost)
    }

    /// Log to stderr if any of the given IDs are not in the connectome (forced spikes for them will be dropped).
    pub fn log_missing_forced_ids(&self, ids: &[String]) {
        let missing: Vec<&String> = ids
            .iter()
            .filter(|id| !self.template.neuron_index_by_id.contains_key(*id))
            .collect();
        if !missing.is_empty() {
            eprintln!(
                "[brain-service] WARNING: {} forced-spike ID(s) not in connectome (will not spike): {:?}",
                missing.len(),
                missing
            );
        }
    }

    /// Register world stim presets once (11PM/3PM/8PM) by resolving root IDs to neuron indices.
    pub fn set_world_stim_presets(&mut self, presets: &HashMap<String, HashMap<String, f64>>) {
        let mut resolved: HashMap<String, Vec<(u32, f32)>> = HashMap::new();
        for (name, rates) in presets {
            let mut items: Vec<(u32, f32)> = Vec::new();
            for (rid, hz) in rates {
                if !hz.is_finite() || *hz <= 0.0 {
                    continue;
                }
                if let Some(&idx) = self.template.neuron_index_by_id.get(rid.as_str()) {
                    if idx < self.n {
                        items.push((idx as u32, *hz as f32));
                    }
                }
            }
            if !items.is_empty() {
                resolved.insert(name.clone(), items);
            }
        }
        self.world_stim_presets = resolved;
    }

    fn refrac_steps(dt: f64) -> u16 {
        let steps = ((REFRACT_MS as f64) / (dt * 1000.0)).ceil();
        if !steps.is_finite() || steps <= 1.0 {
            1
        } else if steps >= u16::MAX as f64 {
            u16::MAX
        } else {
            steps as u16
        }
    }

    fn next_uniform(state: &mut u64) -> f64 {
        // xorshift64* PRNG. Deterministic and fast, good enough for Poisson sampling.
        let mut x = *state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        *state = x;
        let y = x.wrapping_mul(0x2545F4914F6CDD1D);
        (y as f64) / (u64::MAX as f64)
    }

    fn apply_poisson_stimulus(
        indices: &[u32],
        rate_hz: f64,
        dt_sec: f64,
        spike_amp: f32,
        rng_state: &mut u64,
        syn_input: &mut [f32],
    ) -> usize {
        if rate_hz <= 0.0 || indices.is_empty() {
            return 0;
        }
        let p = (rate_hz * dt_sec).clamp(0.0, 1.0);
        if p <= 0.0 {
            return 0;
        }
        let mut spikes_applied = 0usize;
        for &idx in indices {
            let i = idx as usize;
            if i >= syn_input.len() {
                continue;
            }
            if Self::next_uniform(rng_state) < p {
                syn_input[i] += spike_amp;
                spikes_applied += 1;
            }
        }
        spikes_applied
    }

    fn run_step_cpu(
        &mut self,
        dt: f64,
        fly: &FlyInput,
        sources: &[SourceInput],
        skip_olfactory: bool,
        olfactory_baseline_rate_hz: Option<f64>,
        forced_spikes: &[String],
        stim_rates_by_id: Option<&HashMap<String, f64>>,
        stim_preset: Option<&str>,
    ) -> (f64, f64) {
        self.ensure_delay_queue_for_dt(dt);
        let dt_ms = (dt * 1000.0) as f32;
        let syn_time_factor = dt_ms / TAU_SYN_MS;
        let mem_alpha = dt_ms / TAU_MEM_MS;
        let refrac_steps = Self::refrac_steps(dt);
        let t_recurrent = Instant::now();

        // Spike-driven: only add contributions from neurons that spiked (O(spikes × out_degree) vs O(edges)).
        self.syn_input.fill(0.0);
        for i in 0..self.n {
            if self.spikes[i] == 0 {
                continue;
            }
            let start = self.template.out_offsets[i] as usize;
            let end = self.template.out_offsets[i + 1] as usize;
            let pre_is_epg = self.template.is_epg[i] > 0;
            for j in start..end {
                let post = self.template.out_post[j] as usize;
                if post < self.n {
                    let mut recurrent_w = self.template.out_weight[j];
                    if self.epg_recurrence_boost != 1.0
                        && pre_is_epg
                        && self.template.is_epg[post] > 0
                    {
                        recurrent_w *= self.epg_recurrence_boost;
                    }
                    self.syn_input[post] += recurrent_w * self.w_syn;
                }
            }
        }
        let mut rng_state = self.rng_state;
        let sensory_spike_amp = SENSORY_POISSON_SCALE * self.w_syn;
        let mut olf_poisson_spikes = 0usize;
        let used_olfactory_rate_hz = if skip_olfactory {
            0.0
        } else {
            olfactory_baseline_rate_hz
                .filter(|v| v.is_finite() && *v > 0.0)
                .unwrap_or(0.0)
        };
        if !skip_olfactory {
            if let Some(rate_hz) = olfactory_baseline_rate_hz.filter(|v| v.is_finite() && *v > 0.0) {
                olf_poisson_spikes += Self::apply_poisson_stimulus(
                    &self.template.sensory_left_indices,
                    rate_hz,
                    dt,
                    sensory_spike_amp,
                    &mut rng_state,
                    &mut self.syn_input,
                );
                olf_poisson_spikes += Self::apply_poisson_stimulus(
                    &self.template.sensory_right_indices,
                    rate_hz,
                    dt,
                    sensory_spike_amp,
                    &mut rng_state,
                    &mut self.syn_input,
                );
                olf_poisson_spikes += Self::apply_poisson_stimulus(
                    &self.template.sensory_unknown_indices,
                    rate_hz,
                    dt,
                    sensory_spike_amp,
                    &mut rng_state,
                    &mut self.syn_input,
                );
                if self.template.sensory_left_indices.is_empty()
                    && self.template.sensory_right_indices.is_empty()
                    && self.template.sensory_unknown_indices.is_empty()
                {
                    olf_poisson_spikes += Self::apply_poisson_stimulus(
                        &self.template.sensory_indices,
                        rate_hz,
                        dt,
                        sensory_spike_amp,
                        &mut rng_state,
                        &mut self.syn_input,
                    );
                }
            }
        }
        // Python parity: per-neuron stim_rates_by_id are Poisson rate injections,
        // not direct forced spikes. Iterate root_ids in sorted order so RNG matches
        // across runs (HashMap iteration order is randomized per process).
        let chosen_preset = if skip_olfactory && stim_rates_by_id.is_none() {
            Some(stim_preset.unwrap_or_else(|| Self::choose_world_preset_for_fly(fly, sources)))
        } else {
            stim_preset
        };
        if let Some(stim_map) = stim_rates_by_id {
            let mut rids: Vec<&String> = stim_map.keys().collect();
            rids.sort();
            let mut found = 0usize;
            for rid in &rids {
                let rate_hz = stim_map[*rid];
                if !rate_hz.is_finite() || rate_hz <= 0.0 {
                    continue;
                }
                let p = (rate_hz * dt).clamp(0.0, 1.0);
                if p <= 0.0 {
                    continue;
                }
                if let Some(&idx) = self.template.neuron_index_by_id.get(rid.as_str()) {
                    if idx < self.n && Self::next_uniform(&mut rng_state) < p {
                        self.syn_input[idx] += sensory_spike_amp;
                        olf_poisson_spikes += 1;
                    }
                    found += 1;
                }
            }
            if self.stim_log_every > 0 && self.step_counter % self.stim_log_every == 0 && !rids.is_empty() {
                eprintln!(
                    "[stim] rates_by_id: {} requested, {} found in connectome (stimulate L1/L2/L6 for 11PM)",
                    rids.len(),
                    found
                );
            }
        } else if let Some(preset) = chosen_preset {
            if let Some(items) = self.world_stim_presets.get(preset) {
                for &(idx_u32, rate_hz) in items {
                    let idx = idx_u32 as usize;
                    if idx >= self.n {
                        continue;
                    }
                    let p = ((rate_hz as f64) * dt).clamp(0.0, 1.0);
                    if p > 0.0 && Self::next_uniform(&mut rng_state) < p {
                        self.syn_input[idx] += sensory_spike_amp;
                        olf_poisson_spikes += 1;
                    }
                }
            }
        }
        // Causal external stimulation is handled as explicit forced spikes
        // below (after LIF integration setup), so recurrent input in subsequent
        // ticks sees real spike events from these neurons.
        self.rng_state = rng_state;
        // EonSystems-style alpha synapse with fixed 1.8ms delay queue.
        // Conductance update uses delayed input and the previous conductance.
        let delayed_base = self.delay_head * self.n;
        let syn_decay = 1.0 - syn_time_factor;
        for i in 0..self.n {
            let delayed = self.delay_buffer[delayed_base + i];
            let refrac_mask = if self.refractory[i] > 0 { 0.0 } else { 1.0 };
            self.g_next[i] = self.g[i] * syn_decay + delayed * refrac_mask;
            // Ring-buffer equivalent of torch.roll(-1) + write-to-last:
            // write current input into the slot we just consumed.
            self.delay_buffer[delayed_base + i] = self.syn_input[i];
        }
        self.delay_head = (self.delay_head + 1) % self.delay_len;
        let recurrent_ms = t_recurrent.elapsed().as_secs_f64() * 1000.0;
        let t_lif = Instant::now();

        // LIF update: same as Python (vRest=-52, vThreshold=-45, tauMem=20ms, alpha synapse).
        let mut spikes_next = vec![0u8; self.n];
        for i in 0..self.n {
            if self.refractory[i] > 0 {
                self.refractory[i] -= 1;
                self.v[i] = V_RESET;
                continue;
            }
            let dv = mem_alpha * (V_REST - self.v[i] + self.g[i]);
            let v_next = self.v[i] + dv;
            if v_next >= V_THRESH {
                spikes_next[i] = 1;
                self.v[i] = V_RESET;
                self.refractory[i] = refrac_steps;
            } else {
                self.v[i] = if v_next.is_finite() { v_next } else { V_REST };
            }
        }
        for i in 0..self.n {
            if spikes_next[i] > 0 {
                self.g_next[i] = 0.0;
            }
        }
        let mut forced_spikes_applied = 0usize;
        if !forced_spikes.is_empty() {
            for id in forced_spikes {
                if let Some(&idx) = self.template.neuron_index_by_id.get(id) {
                    if idx < self.n {
                        spikes_next[idx] = 1;
                        self.v[idx] = V_RESET;
                        self.refractory[idx] = refrac_steps;
                        self.g_next[idx] = 0.0;
                        forced_spikes_applied += 1;
                    }
                }
            }
        }
        let network_spikes_step = spikes_next.iter().filter(|&&v| v > 0).count() as u64;
        self.step_counter = self.step_counter.wrapping_add(1);
        self.olf_poisson_total = self.olf_poisson_total.saturating_add(olf_poisson_spikes as u64);
        self.forced_spikes_total = self
            .forced_spikes_total
            .saturating_add(forced_spikes_applied as u64);
        self.network_spikes_total = self.network_spikes_total.saturating_add(network_spikes_step);
        if self.stim_log_every > 0 && self.step_counter % self.stim_log_every == 0 {
            eprintln!(
                "[stim] step={} dt_sec={:.6} olfactory_hz={:.3} olf_pool(L/R/U/all)={}/{}/{}/{} olf_poisson_spikes_step={} forced_spikes_step={} network_spikes_step={} olf_poisson_total={} forced_spikes_total={} network_spikes_total={}",
                self.step_counter,
                dt,
                used_olfactory_rate_hz,
                self.template.sensory_left_indices.len(),
                self.template.sensory_right_indices.len(),
                self.template.sensory_unknown_indices.len(),
                self.template.sensory_indices.len(),
                olf_poisson_spikes,
                forced_spikes_applied,
                network_spikes_step,
                self.olf_poisson_total,
                self.forced_spikes_total,
                self.network_spikes_total
            );
        }
        std::mem::swap(&mut self.g, &mut self.g_next);
        self.spikes = spikes_next;
        let lif_ms = t_lif.elapsed().as_secs_f64() * 1000.0;
        (recurrent_ms, lif_ms)
    }

    #[cfg(feature = "cuda")]
    fn run_step_gpu(
        &mut self,
        dt: f64,
        fly: &FlyInput,
        sources: &[SourceInput],
        skip_olfactory: bool,
        olfactory_baseline_rate_hz: Option<f64>,
        forced_spikes: &[String],
        stim_rates_by_id: Option<&HashMap<String, f64>>,
        stim_preset: Option<&str>,
    ) -> Option<(f64, f64)> {
        let gpu = self.gpu.take().expect("[brain-service] run_step_gpu called without GPU state");

        let delay_steps = Self::compute_synaptic_delay_steps(dt);
        let desired_len = delay_steps.saturating_add(1);
        let mut gpu = gpu;
        gpu.ensure_delay_len(desired_len);

        let sensory_spike_amp = SENSORY_POISSON_SCALE * self.w_syn;
        let mut syn_input_host: Option<&[f32]> = None;
        let mut gpu_stim_indices: Vec<u32> = Vec::new();
        let mut gpu_stim_rates_hz: Vec<f32> = Vec::new();
        let mut olf_poisson_spikes = 0usize;
        let used_olfactory_rate_hz = if skip_olfactory {
            0.0
        } else {
            olfactory_baseline_rate_hz
                .filter(|v| v.is_finite() && *v > 0.0)
                .unwrap_or(0.0)
        };
        // Fast path for world simulation: skip CPU Poisson array build and run sparse
        // stim_rates_by_id Poisson directly on GPU.
        let chosen_preset = if skip_olfactory && stim_rates_by_id.is_none() {
            Some(stim_preset.unwrap_or_else(|| Self::choose_world_preset_for_fly(fly, sources)))
        } else {
            stim_preset
        };
        let use_gpu_sparse_stim = skip_olfactory && olfactory_baseline_rate_hz.is_none();
        if use_gpu_sparse_stim {
            if let Some(stim_map) = stim_rates_by_id {
                let mut rids: Vec<&String> = stim_map.keys().collect();
                rids.sort();
                let mut found = 0usize;
                for rid in &rids {
                    let rate_hz = stim_map[*rid];
                    if !rate_hz.is_finite() || rate_hz <= 0.0 {
                        continue;
                    }
                    if let Some(&idx) = self.template.neuron_index_by_id.get(rid.as_str()) {
                        if idx < self.n {
                            gpu_stim_indices.push(idx as u32);
                            gpu_stim_rates_hz.push(rate_hz as f32);
                        }
                        found += 1;
                    }
                }
                if self.stim_log_every > 0
                    && self.step_counter % self.stim_log_every == 0
                    && !rids.is_empty()
                {
                    eprintln!(
                        "[stim][gpu] rates_by_id: {} requested, {} found in connectome",
                        rids.len(), found
                    );
                }
            }
            if gpu_stim_indices.is_empty() {
                if let Some(preset) = chosen_preset {
                    if let Some(items) = self.world_stim_presets.get(preset) {
                        gpu_stim_indices.reserve(items.len());
                        gpu_stim_rates_hz.reserve(items.len());
                        for &(idx, hz) in items {
                            gpu_stim_indices.push(idx);
                            gpu_stim_rates_hz.push(hz);
                        }
                    }
                }
            }
        } else {
            // --- Poisson / stim input computed on CPU (same logic as run_step_cpu) ---
            self.syn_input.fill(0.0);
            let mut rng_state = self.rng_state;
            if !skip_olfactory {
                if let Some(rate_hz) =
                    olfactory_baseline_rate_hz.filter(|v| v.is_finite() && *v > 0.0)
                {
                    olf_poisson_spikes += Self::apply_poisson_stimulus(
                        &self.template.sensory_left_indices,
                        rate_hz,
                        dt,
                        sensory_spike_amp,
                        &mut rng_state,
                        &mut self.syn_input,
                    );
                    olf_poisson_spikes += Self::apply_poisson_stimulus(
                        &self.template.sensory_right_indices,
                        rate_hz,
                        dt,
                        sensory_spike_amp,
                        &mut rng_state,
                        &mut self.syn_input,
                    );
                    olf_poisson_spikes += Self::apply_poisson_stimulus(
                        &self.template.sensory_unknown_indices,
                        rate_hz,
                        dt,
                        sensory_spike_amp,
                        &mut rng_state,
                        &mut self.syn_input,
                    );
                    if self.template.sensory_left_indices.is_empty()
                        && self.template.sensory_right_indices.is_empty()
                        && self.template.sensory_unknown_indices.is_empty()
                    {
                        olf_poisson_spikes += Self::apply_poisson_stimulus(
                            &self.template.sensory_indices,
                            rate_hz,
                            dt,
                            sensory_spike_amp,
                            &mut rng_state,
                            &mut self.syn_input,
                        );
                    }
                }
            }
            if let Some(stim_map) = stim_rates_by_id {
                let mut rids: Vec<&String> = stim_map.keys().collect();
                rids.sort();
                let mut found = 0usize;
                for rid in &rids {
                    let rate_hz = stim_map[*rid];
                    if !rate_hz.is_finite() || rate_hz <= 0.0 {
                        continue;
                    }
                    let p = (rate_hz * dt).clamp(0.0, 1.0);
                    if p <= 0.0 {
                        continue;
                    }
                    if let Some(&idx) = self.template.neuron_index_by_id.get(rid.as_str()) {
                        if idx < self.n && Self::next_uniform(&mut rng_state) < p {
                            self.syn_input[idx] += sensory_spike_amp;
                            olf_poisson_spikes += 1;
                        }
                        found += 1;
                    }
                }
                if self.stim_log_every > 0
                    && self.step_counter % self.stim_log_every == 0
                    && !rids.is_empty()
                {
                    eprintln!(
                        "[stim][gpu] rates_by_id: {} requested, {} found in connectome",
                        rids.len(),
                        found
                    );
                }
            }
            self.rng_state = rng_state;
            syn_input_host = Some(&self.syn_input);
        }

        // Resolve forced spike IDs to neuron indices
        let mut forced_indices: Vec<u32> = Vec::new();
        for id in forced_spikes {
            if let Some(&idx) = self.template.neuron_index_by_id.get(id) {
                if idx < self.n {
                    forced_indices.push(idx as u32);
                }
            }
        }

        // --- GPU step ---
        let (recurrent_ms, lif_ms, network_spikes_step_gpu) = match gpu.step(
            dt,
            syn_input_host,
            if gpu_stim_indices.is_empty() {
                None
            } else {
                Some((&gpu_stim_indices, &gpu_stim_rates_hz, sensory_spike_amp))
            },
            self.w_syn,
            self.epg_recurrence_boost,
            &forced_indices,
        ) {
            Some(v) => v,
            None => {
                eprintln!(
                    "[brain-service][gpu] GPU step failed, falling back to CPU (dt={:.6}, forced={}, stim_rates={}, preset={})",
                    dt,
                    forced_indices.len(),
                    stim_rates_by_id.map(|m| m.len()).unwrap_or(0),
                    stim_preset.unwrap_or("none"),
                );
                // Disable GPU for this sim instance after failure.
                self.gpu = None;
                return None;
            }
        };
        let epg_indices = gpu.epg_indices();
        for &idx in epg_indices {
            self.spikes[idx as usize] = 0;
        }
        let epg_spikes = gpu.last_epg_spikes();
        for (j, &idx) in epg_indices.iter().enumerate() {
            if j < epg_spikes.len() {
                self.spikes[idx as usize] = epg_spikes[j];
            }
        }
        self.gpu = Some(gpu);

        let forced_spikes_applied = forced_indices.len();
        let network_spikes_step = network_spikes_step_gpu as u64;
        self.step_counter = self.step_counter.wrapping_add(1);
        self.olf_poisson_total = self.olf_poisson_total.saturating_add(olf_poisson_spikes as u64);
        self.forced_spikes_total = self.forced_spikes_total.saturating_add(forced_spikes_applied as u64);
        self.network_spikes_total = self.network_spikes_total.saturating_add(network_spikes_step);
        if self.stim_log_every > 0 && self.step_counter % self.stim_log_every == 0 {
            eprintln!(
                "[stim][gpu] step={} dt_sec={:.6} olfactory_hz={:.3} olf_pool(L/R/U/all)={}/{}/{}/{} olf_poisson_spikes_step={} forced_spikes_step={} network_spikes_step={} olf_poisson_total={} forced_spikes_total={} network_spikes_total={}",
                self.step_counter,
                dt,
                used_olfactory_rate_hz,
                self.template.sensory_left_indices.len(),
                self.template.sensory_right_indices.len(),
                self.template.sensory_unknown_indices.len(),
                self.template.sensory_indices.len(),
                olf_poisson_spikes,
                forced_spikes_applied,
                network_spikes_step,
                self.olf_poisson_total,
                self.forced_spikes_total,
                self.network_spikes_total
            );
        }
        Some((recurrent_ms, lif_ms))
    }

    pub fn step(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
    ) -> (
        Vec<f32>,
        HashMap<String, f64>,
        Vec<String>,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        StepTiming,
        FlyStepOutput,
    ) {
        self.step_with_options(dt, fly, sources, true, false, None, Vec::new(), None, None)
    }

    pub fn step_with_options(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
        include_activity: bool,
        skip_olfactory: bool,
        olfactory_baseline_rate_hz: Option<f64>,
        forced_spikes: Vec<String>,
        stim_rates_by_id: Option<&HashMap<String, f64>>,
        stim_preset: Option<&str>,
    ) -> (
        Vec<f32>,
        HashMap<String, f64>,
        Vec<String>,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        StepTiming,
        FlyStepOutput,
    ) {
        self.step_with_options_inner(
            dt, fly, sources, include_activity, true,
            skip_olfactory, olfactory_baseline_rate_hz, forced_spikes, stim_rates_by_id, stim_preset,
        )
    }

    /// Fast path for intermediate run_steps iterations: skips spike-ID string
    /// cloning and activity HashMap construction.
    pub fn step_fast(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
        skip_olfactory: bool,
        olfactory_baseline_rate_hz: Option<f64>,
        forced_spikes: Vec<String>,
        stim_rates_by_id: Option<&HashMap<String, f64>>,
        stim_preset: Option<&str>,
    ) -> (
        Vec<f32>,
        HashMap<String, f64>,
        Vec<String>,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        StepTiming,
        FlyStepOutput,
    ) {
        self.step_with_options_inner(
            dt, fly, sources, false, false,
            skip_olfactory, olfactory_baseline_rate_hz, forced_spikes, stim_rates_by_id, stim_preset,
        )
    }

    fn step_with_options_inner(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
        include_activity: bool,
        build_spike_ids: bool,
        skip_olfactory: bool,
        olfactory_baseline_rate_hz: Option<f64>,
        forced_spikes: Vec<String>,
        stim_rates_by_id: Option<&HashMap<String, f64>>,
        stim_preset: Option<&str>,
    ) -> (
        Vec<f32>,
        HashMap<String, f64>,
        Vec<String>,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        StepTiming,
        FlyStepOutput,
    ) {
        let t_compute = Instant::now();
        let (recurrent_ms, lif_ms) = {
            #[cfg(feature = "cuda")]
            {
                if self.gpu.is_some() {
                    if let Some(v) = self.run_step_gpu(
                        dt,
                        &fly,
                        &sources,
                        skip_olfactory,
                        olfactory_baseline_rate_hz,
                        &forced_spikes,
                        stim_rates_by_id,
                        stim_preset,
                    ) {
                        v
                    } else {
                        self.run_step_cpu(
                            dt,
                            &fly,
                            &sources,
                            skip_olfactory,
                            olfactory_baseline_rate_hz,
                            &forced_spikes,
                            stim_rates_by_id,
                            stim_preset,
                        )
                    }
                } else {
                    self.run_step_cpu(
                        dt,
                        &fly,
                        &sources,
                        skip_olfactory,
                        olfactory_baseline_rate_hz,
                        &forced_spikes,
                        stim_rates_by_id,
                        stim_preset,
                    )
                }
            }
            #[cfg(not(feature = "cuda"))]
            {
                self.run_step_cpu(
                    dt,
                    &fly,
                    &sources,
                    skip_olfactory,
                    olfactory_baseline_rate_hz,
                    &forced_spikes,
                    stim_rates_by_id,
                    stim_preset,
                )
            }
        };
        let kernel_ms = recurrent_ms + lif_ms;
        let t_readout = Instant::now();

        let mut activity_sparse = HashMap::new();
        let mut activity: Vec<f32> = Vec::new();
        let all_spike_ids: Vec<String> = if build_spike_ids {
            (0..self.n)
                .filter_map(|i| {
                    if self.spikes[i] >= ACTIVITY_THRESHOLD {
                        self.template.neuron_ids.get(i).cloned()
                    } else {
                        None
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        if include_activity {
            activity = vec![0.0f32; self.n];
            let cap = self.max_activity_entries;
            for i in 0..self.n {
                if self.spikes[i] >= ACTIVITY_THRESHOLD {
                    activity[i] = 1.0;
                    if activity_sparse.len() < cap {
                        if let Some(id) = self.template.neuron_ids.get(i) {
                            activity_sparse.insert(id.clone(), 1.0);
                        }
                    }
                }
            }
        }

        if fly.rest_time_left > 0.0 {
            self.spikes.fill(0);
            #[cfg(feature = "cuda")]
            if let Some(ref mut gpu) = self.gpu {
                gpu.sync_spikes_from_host(&self.spikes);
            }
            if include_activity {
                activity.fill(0.0);
            }
            activity_sparse.clear();
        }
        let readout_ms = t_readout.elapsed().as_secs_f64() * 1000.0;
        let compute_ms = t_compute.elapsed().as_secs_f64() * 1000.0;
        let next_t = fly.t + dt;
        let next_rest_time_left = fly.rest_time_left.max(0.0);

        let fly_out = FlyStepOutput {
            x: fly.x,
            y: fly.y,
            z: fly.z,
            heading: fly.heading,
            t: next_t,
            hunger: fly.hunger,
            health: fly.health,
            dead: fly.dead,
            fly_time_left: 1.0,
            rest_time_left: next_rest_time_left,
            rest_duration: 0.0,
            feeding: false,
            eaten_food_id: None,
            feeding_candidate_id: None,
            feeding_sugar_taken: 0.0,
        };

        (
            activity,
            activity_sparse,
            all_spike_ids,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            StepTiming {
                compute_ms,
                kernel_ms,
                recurrent_ms,
                lif_ms,
                readout_ms,
            },
            fly_out,
        )
    }
}
