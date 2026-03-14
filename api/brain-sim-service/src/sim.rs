//! Spike-based LIF simulation logic (CPU + optional GPU).
use std::collections::HashMap;
use std::time::Instant;

#[cfg(feature = "cuda")]
use crate::gpu::{GpuSimState, GpuStepResult};

const STIM_RATE_HZ: f64 = 200.0;
const SENSORY_SCALE: f64 = 0.18;
const V_REST: f32 = -52.0;
const V_RESET: f32 = -52.0;
const V_THRESH: f32 = -45.0;
const TAU_MEM_MS: f32 = 20.0;
const TAU_SYN_MS: f32 = 5.0;
const RECURRENT_SCALE: f32 = 0.275;
const REFRACT_MS: f64 = 2.2;
const ACTIVITY_THRESHOLD: u8 = 1;
const MOTOR_SCALE: f64 = 0.002;
// Ignore near-zero food distance to avoid singular-like gain when the fly is
// effectively at the food source (handled separately by consumption logic).
const MIN_FOOD_DISTANCE: f64 = 1.0;

pub struct BrainSim {
    n: usize,
    neuron_ids: Vec<String>,
    id_to_idx: HashMap<String, u32>,
    edges_pre: Vec<u32>,
    edges_post: Vec<u32>,
    edges_weight: Vec<f32>,
    sensory_indices: Vec<u32>,
    motor_left: Vec<u32>,
    motor_right: Vec<u32>,
    motor_unknown: Vec<u32>,
    v: Vec<f32>,
    g: Vec<f32>,
    refractory: Vec<u16>,
    spikes: Vec<u8>,
    viewer_indices: Vec<u32>,
    max_activity_entries: usize,
    #[cfg(feature = "cuda")]
    gpu_state: Option<GpuSimState>,
    #[cfg(feature = "cuda")]
    cuda_only: bool,
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
}

pub struct SourceInput {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
}

pub struct PendingStimInput {
    pub neuron_ids: Vec<String>,
    pub strength: f64,
}

pub struct StepTiming {
    pub compute_ms: f64,
    pub kernel_ms: f64,
    pub recurrent_ms: f64,
    pub lif_ms: f64,
    pub readout_ms: f64,
}

impl BrainSim {
    fn readout_activity_cap() -> usize {
        let parsed = std::env::var("NEUROSIM_ACTIVITY_CAP")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(10_000);
        parsed.max(1)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        neuron_ids: Vec<String>,
        edges_pre: Vec<u32>,
        edges_post: Vec<u32>,
        edges_weight: Vec<f32>,
        sensory_indices: Vec<u32>,
        motor_left: Vec<u32>,
        motor_right: Vec<u32>,
        motor_unknown: Vec<u32>,
    ) -> Self {
        Self::new_with_viewer(
            neuron_ids,
            edges_pre,
            edges_post,
            edges_weight,
            sensory_indices,
            motor_left,
            motor_right,
            motor_unknown,
            Vec::new(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_viewer(
        neuron_ids: Vec<String>,
        edges_pre: Vec<u32>,
        edges_post: Vec<u32>,
        edges_weight: Vec<f32>,
        sensory_indices: Vec<u32>,
        motor_left: Vec<u32>,
        motor_right: Vec<u32>,
        motor_unknown: Vec<u32>,
        viewer_indices: Vec<u32>,
    ) -> Self {
        let n = neuron_ids.len();
        let id_to_idx: HashMap<String, u32> = neuron_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), i as u32))
            .collect();
        let v = vec![V_REST; n];
        let g = vec![0.0f32; n];
        let refractory = vec![0u16; n];
        let spikes = vec![0u8; n];
        let mut sanitized_viewer: Vec<u32> = if viewer_indices.is_empty() {
            (0..n as u32).collect()
        } else {
            viewer_indices
                .into_iter()
                .filter(|&i| (i as usize) < n)
                .collect()
        };
        sanitized_viewer.sort_unstable();
        sanitized_viewer.dedup();
        if sanitized_viewer.is_empty() {
            sanitized_viewer = (0..n as u32).collect();
        }
        let max_activity_entries = Self::readout_activity_cap();
        #[cfg(feature = "cuda")]
        let cuda_only = std::env::var("NEUROSIM_MODE").as_deref() == Ok("cuda")
            || std::env::var("USE_CUDA").as_deref() == Ok("1");
        #[cfg(feature = "cuda")]
        let gpu_state = if cuda_only {
            match GpuSimState::new(n, &edges_pre, &edges_post, &edges_weight, &v, &g, &refractory, &spikes) {
                Some(gpu) => Some(gpu),
                None => panic!("[brain-service] CUDA required but GPU init failed"),
            }
        } else {
            None
        };
        Self {
            n,
            neuron_ids,
            id_to_idx,
            edges_pre,
            edges_post,
            edges_weight,
            sensory_indices,
            motor_left,
            motor_right,
            motor_unknown,
            v,
            g,
            refractory,
            spikes,
            viewer_indices: sanitized_viewer,
            max_activity_entries,
            #[cfg(feature = "cuda")]
            gpu_state,
            #[cfg(feature = "cuda")]
            cuda_only,
        }
    }

    fn refrac_steps(dt: f64) -> u16 {
        let steps = (REFRACT_MS / (dt * 1000.0)).ceil();
        if !steps.is_finite() || steps <= 1.0 {
            1
        } else if steps >= u16::MAX as f64 {
            u16::MAX
        } else {
            steps as u16
        }
    }

    fn sensory_strength(&self, dt: f64, fly: &FlyInput, sources: &[SourceInput]) -> f32 {
        if self.sensory_indices.is_empty() {
            return 0.0;
        }
        let hungry = fly.hunger <= 90.0;
        let full = fly.hunger > 90.0;
        let mut food_modulation = 0.0f64;
        for s in sources {
            let dist = ((s.x - fly.x).powi(2) + (s.y - fly.y).powi(2)).sqrt();
            if dist < MIN_FOOD_DISTANCE {
                continue;
            }
            let inv_dist = 1.0 / (1.0 + dist * 0.1);
            food_modulation += inv_dist * (1.0 - fly.hunger / 100.0);
        }
        let rate_hz = if hungry && food_modulation > 0.0 {
            (50.0 + food_modulation * STIM_RATE_HZ).min(STIM_RATE_HZ)
        } else if full {
            30.0
        } else {
            50.0
        };
        ((rate_hz / STIM_RATE_HZ) * SENSORY_SCALE * (dt / (1.0 / 30.0))).min(0.5) as f32
    }

    fn run_step_cpu(
        &mut self,
        dt: f64,
        fly: &FlyInput,
        sources: &[SourceInput],
        pending: &[PendingStimInput],
    ) -> (f64, f64) {
        let dt_ms = (dt * 1000.0) as f32;
        let syn_decay = (-dt_ms / TAU_SYN_MS).exp();
        let mem_alpha = dt_ms / TAU_MEM_MS;
        let refrac_steps = Self::refrac_steps(dt);
        let t_recurrent = Instant::now();

        for gi in &mut self.g {
            *gi *= syn_decay;
        }
        for e in 0..self.edges_pre.len() {
            let pre = self.edges_pre[e] as usize;
            let post = self.edges_post[e] as usize;
            if pre < self.n && post < self.n && self.spikes[pre] > 0 {
                self.g[post] += self.edges_weight[e] * RECURRENT_SCALE;
            }
        }
        let sensory_strength = self.sensory_strength(dt, fly, sources);
        if sensory_strength > 0.0 {
            for &idx in &self.sensory_indices {
                let i = idx as usize;
                if i < self.n {
                    self.g[i] += sensory_strength;
                }
            }
        }
        for stim in pending {
            let strength = (stim.strength as f32).min(2.0).max(0.0);
            for id in &stim.neuron_ids {
                if let Some(&idx) = self.id_to_idx.get(id) {
                    let i = idx as usize;
                    if i < self.n {
                        self.g[i] += strength;
                    }
                }
            }
        }
        let recurrent_ms = t_recurrent.elapsed().as_secs_f64() * 1000.0;
        let t_lif = Instant::now();

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
        self.spikes = spikes_next;
        let lif_ms = t_lif.elapsed().as_secs_f64() * 1000.0;
        (recurrent_ms, lif_ms)
    }

    pub fn step(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
        pending: Vec<PendingStimInput>,
    ) -> (Vec<f32>, HashMap<String, f64>, f64, f64, f64, StepTiming) {
        self.step_with_options(dt, fly, sources, pending, true)
    }

    pub fn step_with_options(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
        pending: Vec<PendingStimInput>,
        include_activity: bool,
    ) -> (Vec<f32>, HashMap<String, f64>, f64, f64, f64, StepTiming) {
        let t_compute = Instant::now();
        let (recurrent_ms, lif_ms) = {
            #[cfg(feature = "cuda")]
            {
                let sensory_strength = self.sensory_strength(dt, &fly, &sources);
                let mut pending_idx = Vec::new();
                let mut pending_strength = Vec::new();
                for stim in &pending {
                    let strength = (stim.strength as f32).min(2.0).max(0.0);
                    for id in &stim.neuron_ids {
                        if let Some(&idx) = self.id_to_idx.get(id) {
                            pending_idx.push(idx);
                            pending_strength.push(strength);
                        }
                    }
                }
                if let Some(ref mut gpu) = self.gpu_state {
                    match gpu.step(
                        dt as f32,
                        &self.sensory_indices,
                        sensory_strength,
                        &pending_idx,
                        &pending_strength,
                    ) {
                        Some(GpuStepResult {
                            spikes,
                            recurrent_ms,
                            lif_ms,
                        }) => {
                            self.spikes = spikes;
                            (recurrent_ms, lif_ms)
                        }
                        None if self.cuda_only => {
                            panic!("[brain-service] CUDA required but GPU step failed")
                        }
                        None => {
                            self.gpu_state = None;
                            self.run_step_cpu(dt, &fly, &sources, &pending)
                        }
                    }
                } else if self.cuda_only {
                    panic!("[brain-service] CUDA required but GPU unavailable");
                } else {
                    self.run_step_cpu(dt, &fly, &sources, &pending)
                }
            }
            #[cfg(not(feature = "cuda"))]
            {
                self.run_step_cpu(dt, &fly, &sources, &pending)
            }
        };
        let kernel_ms = recurrent_ms + lif_ms;
        let t_readout = Instant::now();

        let mut activity_sparse = HashMap::new();
        let mut activity: Vec<f32> = Vec::new();
        if include_activity {
            activity = vec![0.0f32; self.n];
            let cap = self.max_activity_entries;
            for &idx in &self.viewer_indices {
                let i = idx as usize;
                if self.spikes[i] >= ACTIVITY_THRESHOLD {
                    activity[i] = 1.0;
                    if activity_sparse.len() < cap {
                        if let Some(id) = self.neuron_ids.get(i) {
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
        for &i in &self.motor_left {
            let idx = i as usize;
            if idx < self.n && self.spikes[idx] > 0 {
                ml += 1.0;
            }
        }
        for &i in &self.motor_right {
            let idx = i as usize;
            if idx < self.n && self.spikes[idx] > 0 {
                mr += 1.0;
            }
        }
        for &i in &self.motor_unknown {
            let idx = i as usize;
            if idx < self.n && self.spikes[idx] > 0 {
                mf += 1.0;
            }
        }
        let readout_ms = t_readout.elapsed().as_secs_f64() * 1000.0;
        let compute_ms = t_compute.elapsed().as_secs_f64() * 1000.0;

        (
            activity,
            activity_sparse,
            ml * MOTOR_SCALE,
            mr * MOTOR_SCALE,
            mf * MOTOR_SCALE,
            StepTiming {
                compute_ms,
                kernel_ms,
                recurrent_ms,
                lif_ms,
                readout_ms,
            },
        )
    }
}
