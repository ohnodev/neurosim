//! Spike-based LIF simulation logic (CPU + optional GPU).
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::connectome::ConnectomeTemplate;

use crate::model_constants::{
    EPG_RECURRENCE_BOOST, REFRACT_MS, TAU_MEM_MS, TAU_SYN_MS, V_RESET, V_REST, V_THRESH, W_SYN,
};

const STIM_RATE_HZ: f64 = 200.0;
const SENSORY_POISSON_SCALE: f32 = 250.0;
const ACTIVITY_THRESHOLD: u8 = 1;
const MOTOR_SCALE: f64 = 0.002;
const MOTOR_TURN_GAIN: f64 = 220.0;
const MOTOR_TURN_RATE_MAX: f64 = 2.8;
const MOTOR_TURN_EMA_TAU_SEC: f64 = 0.35;
const ARENA: f64 = 24.0;
const WALL_MARGIN: f64 = 6.0;
const FLY_TIME_MAX: f64 = 6.0;
const REST_TIME: f64 = 4.0;
const GROUND_Z: f64 = 0.35;
const FLIGHT_Z: f64 = 1.5;
const ON_GROUND_THRESH: f64 = 0.6;
const EAT_RADIUS: f64 = 2.5;
const NEAR_FOOD_RADIUS: f64 = 3.2;
const ODOR_DETECTION_RADIUS: f64 = 34.0;
const HUNGER_DECAY: f64 = 0.8;
const HEALTH_DECAY: f64 = 2.5;
const MOVE_SPEED: f64 = 10.0;
const BASELINE_EXPLORE: f64 = 0.03;
const FEEDING_STIM_BONUS: f64 = 0.25;
const SYNAPTIC_DELAY_MS: f32 = 1.8;
// Ignore near-zero food distance to avoid singular-like gain when the fly is
// effectively at the food source (handled separately by consumption logic).
const MIN_FOOD_DISTANCE: f64 = 1.0;

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
    viewer_indices: Vec<u32>,
    max_activity_entries: usize,
    fly_time_left_sec: f64,
    motor_turn_ema: f64,
    rng_state: u64,
    stim_log_every: u64,
    step_counter: u64,
    olf_poisson_total: u64,
    forced_spikes_total: u64,
    network_spikes_total: u64,
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

struct SensoryDrive {
    left_rate_hz: f64,
    right_rate_hz: f64,
    center_rate_hz: f64,
}

impl BrainSim {
    pub fn set_rng_seed(&mut self, seed: u64) {
        self.rng_state = seed;
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
            .unwrap_or(100)
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
        let viewer_indices = template.viewer_subset_indices.clone();
        let delay_len = Self::compute_synaptic_delay_steps(0.001).saturating_add(1);
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
            viewer_indices,
            max_activity_entries: Self::readout_activity_cap(),
            fly_time_left_sec: FLY_TIME_MAX,
            motor_turn_ema: 0.0,
            rng_state: 0x9E3779B97F4A7C15u64,
            stim_log_every: Self::stim_log_interval(),
            step_counter: 0,
            olf_poisson_total: 0,
            forced_spikes_total: 0,
            network_spikes_total: 0,
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

    fn angle_toward(heading: f64, dx: f64, dy: f64) -> f64 {
        let target = dy.atan2(dx);
        let mut d = target - heading;
        while d > std::f64::consts::PI {
            d -= 2.0 * std::f64::consts::PI;
        }
        while d < -std::f64::consts::PI {
            d += 2.0 * std::f64::consts::PI;
        }
        d
    }

    fn normalize_angle(mut a: f64) -> f64 {
        while a > std::f64::consts::PI {
            a -= 2.0 * std::f64::consts::PI;
        }
        while a < -std::f64::consts::PI {
            a += 2.0 * std::f64::consts::PI;
        }
        a
    }

    fn sensory_drive(&self, fly: &FlyInput, sources: &[SourceInput]) -> SensoryDrive {
        if self.template.sensory_indices.is_empty() {
            return SensoryDrive {
                left_rate_hz: 0.0,
                right_rate_hz: 0.0,
                center_rate_hz: 0.0,
            };
        }
        let hungry = fly.hunger <= 90.0;
        let full = fly.hunger > 90.0;
        let hunger_mod = (1.0 - fly.hunger / 100.0).max(0.0);
        let mut left_modulation = 0.0f64;
        let mut right_modulation = 0.0f64;
        let mut center_modulation = 0.0f64;
        let mut near_food = false;
        for s in sources {
            let to_x = s.x - fly.x;
            let to_y = s.y - fly.y;
            let dist = (to_x.powi(2) + to_y.powi(2)).sqrt();
            if dist < EAT_RADIUS && fly.z <= 1.2 {
                near_food = true;
            }
            if dist > ODOR_DETECTION_RADIUS {
                continue;
            }
            if dist < MIN_FOOD_DISTANCE {
                continue;
            }
            let inv_dist = 1.0 / (1.0 + dist * 0.1);
            let intensity = inv_dist * hunger_mod;
            if intensity <= 0.0 {
                continue;
            }
            let target = to_y.atan2(to_x);
            let delta = Self::normalize_angle(target - fly.heading);
            let lateral = delta.sin();
            let leftness = lateral.max(0.0);
            let rightness = (-lateral).max(0.0);
            // Pure lateralization: avoid symmetric baseline stimulation that can
            // collapse steering into near-zero L/R differences.
            left_modulation += intensity * leftness;
            right_modulation += intensity * rightness;
            center_modulation += intensity * (1.0 - 0.4 * lateral.abs());
        }
        let to_rate_hz = |modulation: f64| -> f64 {
            if modulation <= 0.0 {
                return 0.0;
            }
            let mut rate_hz = if hungry && modulation > 0.0 {
                (50.0 + modulation * STIM_RATE_HZ).min(STIM_RATE_HZ)
            } else if full {
                30.0
            } else {
                50.0
            };
            if near_food {
                rate_hz = (rate_hz + STIM_RATE_HZ * FEEDING_STIM_BONUS).min(STIM_RATE_HZ);
            }
            rate_hz
        };
        SensoryDrive {
            left_rate_hz: to_rate_hz(left_modulation),
            right_rate_hz: to_rate_hz(right_modulation),
            center_rate_hz: to_rate_hz(center_modulation),
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
        } else {
            let sensory = self.sensory_drive(fly, sources);
            olf_poisson_spikes += Self::apply_poisson_stimulus(
                &self.template.sensory_left_indices,
                sensory.left_rate_hz,
                dt,
                sensory_spike_amp,
                &mut rng_state,
                &mut self.syn_input,
            );
            olf_poisson_spikes += Self::apply_poisson_stimulus(
                &self.template.sensory_right_indices,
                sensory.right_rate_hz,
                dt,
                sensory_spike_amp,
                &mut rng_state,
                &mut self.syn_input,
            );
            let unknown_rate_hz =
                ((sensory.left_rate_hz + sensory.right_rate_hz + sensory.center_rate_hz) / 3.0)
                    .max(0.0);
            olf_poisson_spikes += Self::apply_poisson_stimulus(
                &self.template.sensory_unknown_indices,
                unknown_rate_hz,
                dt,
                sensory_spike_amp,
                &mut rng_state,
                &mut self.syn_input,
            );
            if self.template.sensory_left_indices.is_empty()
                && self.template.sensory_right_indices.is_empty()
                && self.template.sensory_unknown_indices.is_empty()
            {
                let fallback_hz = sensory
                    .center_rate_hz
                    .max(sensory.left_rate_hz.max(sensory.right_rate_hz));
                olf_poisson_spikes += Self::apply_poisson_stimulus(
                    &self.template.sensory_indices,
                    fallback_hz,
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
        self.step_with_options(dt, fly, sources, true, false, None, Vec::new(), None)
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
                self.run_step_cpu(
                    dt,
                    &fly,
                    &sources,
                    skip_olfactory,
                    olfactory_baseline_rate_hz,
                    &forced_spikes,
                    stim_rates_by_id,
                )
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
                )
            }
        };
        let kernel_ms = recurrent_ms + lif_ms;
        let t_readout = Instant::now();

        let mut activity_sparse = HashMap::new();
        let mut activity: Vec<f32> = Vec::new();
        let all_spike_ids: Vec<String> = self
            .template
            .neuron_ids
            .iter()
            .enumerate()
            .filter(|(i, _)| self.spikes[*i] >= ACTIVITY_THRESHOLD)
            .map(|(_, id): (usize, &String)| id.clone())
            .collect();
        if include_activity {
            activity = vec![0.0f32; self.n];
            let cap = self.max_activity_entries;
            for &idx in &self.viewer_indices {
                let i = idx as usize;
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
            if include_activity {
                activity.fill(0.0);
            }
            activity_sparse.clear();
        }

        let mut ml = 0.0f64;
        let mut mr = 0.0f64;
        let mut mf = 0.0f64;
        let mut ml_count = 0.0f64;
        let mut mr_count = 0.0f64;
        let mut mf_count = 0.0f64;
        for &i in &self.template.motor_left {
            let idx = i as usize;
            if idx < self.n {
                let spike = self.spikes[idx] as f64;
                ml += spike;
                if spike > 0.0 {
                    ml_count += 1.0;
                }
            }
        }
        for &i in &self.template.motor_right {
            let idx = i as usize;
            if idx < self.n {
                let spike = self.spikes[idx] as f64;
                mr += spike;
                if spike > 0.0 {
                    mr_count += 1.0;
                }
            }
        }
        for &i in &self.template.motor_unknown {
            let idx = i as usize;
            if idx < self.n {
                let spike = self.spikes[idx] as f64;
                mf += spike;
                if spike > 0.0 {
                    mf_count += 1.0;
                }
            }
        }
        let readout_ms = t_readout.elapsed().as_secs_f64() * 1000.0;
        let compute_ms = t_compute.elapsed().as_secs_f64() * 1000.0;

        let t = fly.t + dt;
        let mut hunger = fly.hunger;
        let mut health = fly.health;
        let mut rest_time_left = fly.rest_time_left;
        let mut dead = fly.dead;
        let eaten_food_id: Option<String> = None;
        let feeding = false;
        let mut feeding_candidate_id: Option<String> = None;
        let mut x = fly.x;
        let mut y = fly.y;
        let mut z = fly.z;
        let mut heading = fly.heading;

        if !dead {
            let on_ground = fly.z < ON_GROUND_THRESH;
            let can_fly_eat = (rest_time_left > 0.0 || on_ground || fly.z < 1.1) && fly.z < 1.2;
            if can_fly_eat {
                for s in &sources {
                    if ((s.x - fly.x).powi(2) + (s.y - fly.y).powi(2)).sqrt() < EAT_RADIUS {
                        feeding_candidate_id = Some(s.id.clone());
                        break;
                    }
                }
            }

            let prev_hunger = hunger;
            if feeding_candidate_id.is_none() {
                hunger = (hunger - HUNGER_DECAY * dt).max(0.0);
            }

            if hunger <= 0.0 {
                let time_at_zero = if prev_hunger <= 0.0 {
                    dt
                } else {
                    (HUNGER_DECAY * dt - prev_hunger).max(0.0) / HUNGER_DECAY
                };
                health = (health - HEALTH_DECAY * time_at_zero).max(0.0);
                if health <= 0.0 {
                    dead = true;
                }
            }

            // Use per-side firing rates (not raw counts) to avoid fixed turn bias
            // when motor bank sizes differ (e.g. 52 left vs 54 right neurons).
            let ml_rate = if self.template.motor_left.is_empty() {
                0.0
            } else {
                ml / self.template.motor_left.len() as f64
            };
            let mr_rate = if self.template.motor_right.is_empty() {
                0.0
            } else {
                mr / self.template.motor_right.len() as f64
            };
            // Steering needs stronger influence than forward drive so small L/R
            // imbalances (e.g. +/-3..5 spikes) still produce visible turns.
            let turn_from_motor = ((ml_rate - mr_rate) * MOTOR_TURN_GAIN)
                .clamp(-MOTOR_TURN_RATE_MAX, MOTOR_TURN_RATE_MAX);
            let forward_from_motor = ml * MOTOR_SCALE + mr * MOTOR_SCALE + mf * MOTOR_SCALE;
            let motor = forward_from_motor.tanh() * 0.5;

            // Smooth motor steering to prevent frame-to-frame sign flip cancellation
            // (e.g. -3/+5 oscillations) from collapsing heading updates.
            let ema_alpha = if dt > 0.0 {
                1.0 - (-dt / MOTOR_TURN_EMA_TAU_SEC).exp()
            } else {
                0.0
            };
            self.motor_turn_ema += (turn_from_motor - self.motor_turn_ema) * ema_alpha.clamp(0.0, 1.0);
            let mut heading_bias = self.motor_turn_ema * dt;
            let near_right = fly.x > ARENA - WALL_MARGIN;
            let near_left = fly.x < -ARENA + WALL_MARGIN;
            let near_top = fly.y > ARENA - WALL_MARGIN;
            let near_bottom = fly.y < -ARENA + WALL_MARGIN;
            let near_corner = (near_right as u8 + near_left as u8 + near_top as u8 + near_bottom as u8) >= 2;
            if near_corner {
                heading_bias += Self::angle_toward(fly.heading, -fly.x, -fly.y) * 0.6 * dt;
            } else {
                if near_right {
                    heading_bias -= 0.2 * dt;
                }
                if near_left {
                    heading_bias += 0.2 * dt;
                }
                if near_top {
                    heading_bias -= 0.2 * dt;
                }
                if near_bottom {
                    heading_bias += 0.2 * dt;
                }
            }

            let mut effective_motor = if rest_time_left <= 0.0 {
                motor.max(BASELINE_EXPLORE)
            } else {
                0.0
            };
            if rest_time_left > 0.0 {
                rest_time_left -= dt;
                effective_motor = 0.0;
                if rest_time_left <= 0.0 {
                    self.fly_time_left_sec = FLY_TIME_MAX;
                }
            } else if effective_motor.abs() > 0.005 {
                self.fly_time_left_sec = (self.fly_time_left_sec - dt * effective_motor.abs()).max(0.0);
                if self.fly_time_left_sec <= 0.0 {
                    rest_time_left = REST_TIME;
                }
            } else {
                self.fly_time_left_sec = (self.fly_time_left_sec + dt * 0.5).min(FLY_TIME_MAX);
            }
            self.fly_time_left_sec = self.fly_time_left_sec.clamp(0.0, FLY_TIME_MAX);

            let dx = fly.heading.cos() * effective_motor * dt * MOVE_SPEED;
            let dy = fly.heading.sin() * effective_motor * dt * MOVE_SPEED;
            x = (fly.x + if dx.is_finite() { dx } else { 0.0 }).clamp(-ARENA, ARENA);
            y = (fly.y + if dy.is_finite() { dy } else { 0.0 }).clamp(-ARENA, ARENA);

            let mut z_drift = 0.0;
            if rest_time_left > 0.0 {
                z_drift = -0.5 * dt;
            } else {
                let mut near_food = false;
                for s in &sources {
                    if ((s.x - fly.x).powi(2) + (s.y - fly.y).powi(2)).sqrt() < NEAR_FOOD_RADIUS {
                        near_food = true;
                        break;
                    }
                }
                if hunger <= 90.0 && near_food {
                    z_drift = -0.6 * dt;
                } else if effective_motor.abs() > 0.005 {
                    z_drift = 0.4 * dt;
                }
            }
            let z_osc = 0.08 * (t * 20.0).sin() * dt;
            z = (fly.z + if z_drift.is_finite() { z_drift } else { 0.0 } + if z_osc.is_finite() { z_osc } else { 0.0 })
                .clamp(GROUND_Z, FLIGHT_Z);

            let two_pi = 2.0 * std::f64::consts::PI;
            let n_heading = fly.heading + if heading_bias.is_finite() { heading_bias } else { 0.0 };
            heading = n_heading - two_pi * ((n_heading + std::f64::consts::PI) / two_pi).floor();
            if !heading.is_finite() {
                heading = fly.heading;
            }
        }

        let fly_out = FlyStepOutput {
            x,
            y,
            z,
            heading,
            t,
            hunger: if hunger.is_finite() { hunger } else { fly.hunger },
            health: if health.is_finite() { health } else { fly.health },
            dead,
            fly_time_left: (self.fly_time_left_sec / FLY_TIME_MAX).clamp(0.0, 1.0),
            rest_time_left: if rest_time_left > 0.0 { rest_time_left } else { 0.0 },
            rest_duration: REST_TIME,
            feeding,
            eaten_food_id,
            feeding_candidate_id,
            feeding_sugar_taken: 0.0,
        };

        (
            activity,
            activity_sparse,
            all_spike_ids,
            ml * MOTOR_SCALE,
            mr * MOTOR_SCALE,
            mf * MOTOR_SCALE,
            ml_count,
            mr_count,
            mf_count,
            ml,
            mr,
            mf,
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
