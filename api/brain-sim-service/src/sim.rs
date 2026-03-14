//! Core brain simulation logic (CPU + optional GPU).
use std::collections::HashMap;
use rayon::prelude::*;

#[cfg(feature = "cuda")]
use crate::gpu::GpuSimState;

const REF_STEP: f64 = 1.0 / 30.0;
const TAU: f64 = 0.004;
const DECAY: f64 = 0.975;
const PROP_CAP: f64 = 0.0004;
const STIM_RATE_HZ: f64 = 200.0;
const SENSORY_SCALE: f64 = 0.18;
const ACTIVITY_MAX: f32 = 0.5;
const ACTIVITY_THRESHOLD: f32 = 0.08;
const MOTOR_SCALE: f64 = 0.002;

pub struct BrainSim {
    n: usize,
    neuron_ids: Vec<String>,
    id_to_idx: HashMap<String, u32>,
    adj: Vec<Vec<(u32, f32)>>,
    sensory_indices: Vec<u32>,
    motor_left: Vec<u32>,
    motor_right: Vec<u32>,
    motor_unknown: Vec<u32>,
    activity: Vec<f32>,
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

impl BrainSim {
    pub fn new(
        neuron_ids: Vec<String>,
        connections: Vec<(String, String, f64)>,
        sensory_indices: Vec<u32>,
        motor_left: Vec<u32>,
        motor_right: Vec<u32>,
        motor_unknown: Vec<u32>,
    ) -> Self {
        let n = neuron_ids.len();
        let id_to_idx: HashMap<String, u32> = neuron_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), i as u32))
            .collect();
        let mut adj: Vec<Vec<(u32, f32)>> = vec![Vec::new(); n];
        for (pre, post, weight) in connections {
            let w = if weight >= 1.0 && weight.is_finite() {
                weight as f32
            } else {
                1.0
            };
            if let (Some(&pi), Some(&po)) = (id_to_idx.get(&pre), id_to_idx.get(&post)) {
                adj[pi as usize].push((po, w));
            }
        }
        let activity = vec![0.0f32; n];
        #[cfg(feature = "cuda")]
        let cuda_only = std::env::var("NEUROSIM_MODE").as_deref() == Ok("cuda")
            || std::env::var("USE_CUDA").as_deref() == Ok("1");
        #[cfg(feature = "cuda")]
        let gpu_state = if cuda_only {
            match GpuSimState::new(n, &adj, &activity) {
                Some(g) => Some(g),
                None => panic!("[brain-service] CUDA required but GPU init failed"),
            }
        } else {
            // CPU mode: never probe CUDA to avoid cudarc dynamic-load panics on non-GPU hosts.
            None
        };
        Self {
            n,
            neuron_ids,
            id_to_idx,
            adj,
            sensory_indices,
            motor_left,
            motor_right,
            motor_unknown,
            activity,
            #[cfg(feature = "cuda")]
            gpu_state,
            #[cfg(feature = "cuda")]
            cuda_only,
        }
    }

    fn run_step_cpu(&self, decay_factor: f32, tau_r: f32, prop_cap_r: f32) -> Vec<f32> {
        let mut next = vec![0.0f32; self.n];
        for i in 0..self.n {
            next[i] = self.activity[i] * decay_factor;
        }
        let activity = &self.activity;
        let adj = &self.adj;
        let n = self.n;
        let prop: Vec<f32> = (0..adj.len())
            .into_par_iter()
            .fold(
                || vec![0.0f32; n],
                |mut local, pre_idx| {
                    let pre_act = activity[pre_idx];
                    if !pre_act.is_finite() || pre_act <= 0.0 {
                        return local;
                    }
                    for &(post_idx, weight) in &adj[pre_idx] {
                        let j = post_idx as usize;
                        if j < n {
                            let w = weight.min(10.0);
                            let v = (pre_act * tau_r * w).min(prop_cap_r);
                            if v.is_finite() {
                                local[j] += v;
                            }
                        }
                    }
                    local
                },
            )
            .reduce(
                || vec![0.0f32; n],
                |mut a, b| {
                    for (i, &v) in b.iter().enumerate() {
                        if i < n && v.is_finite() {
                            a[i] += v;
                        }
                    }
                    a
                },
            );
        for (i, &v) in prop.iter().enumerate() {
            if i < n {
                next[i] += v;
            }
        }
        for v in &mut next {
            *v = (*v).clamp(0.0, ACTIVITY_MAX);
            if !v.is_finite() {
                *v = 0.0;
            }
        }
        next
    }

    pub fn step(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
        pending: Vec<PendingStimInput>,
    ) -> (Vec<f32>, HashMap<String, f64>, f64, f64, f64) {
        let r = (dt / REF_STEP).clamp(0.1, 3.0);
        let decay_factor = DECAY.powf(r) as f32;
        let tau_r = (TAU * r) as f32;
        let prop_cap_r = (PROP_CAP * r) as f32;

        let mut next;
        #[cfg(feature = "cuda")]
        let mut demote_gpu = false;
        #[cfg(feature = "cuda")]
        {
            next = if let Some(ref mut gpu) = self.gpu_state {
                match gpu.step(
                    &self.activity,
                    decay_factor,
                    tau_r,
                    prop_cap_r,
                    ACTIVITY_MAX,
                ) {
                    Some(v) => v,
                    None if self.cuda_only => panic!("[brain-service] CUDA required but step failed"),
                    None => {
                        demote_gpu = true;
                        self.run_step_cpu(decay_factor, tau_r, prop_cap_r)
                    }
                }
            } else if self.cuda_only {
                panic!("[brain-service] CUDA required but GPU unavailable");
            } else {
                self.run_step_cpu(decay_factor, tau_r, prop_cap_r)
            };
            if demote_gpu {
                self.gpu_state = None;
            }
        }
        #[cfg(not(feature = "cuda"))]
        {
            next = self.run_step_cpu(decay_factor, tau_r, prop_cap_r);
        }

        if !self.sensory_indices.is_empty() {
            let hungry = fly.hunger <= 90.0;
            let full = fly.hunger > 90.0;
            let mut food_modulation = 0.0f64;
            for s in &sources {
                let dist = ((s.x - fly.x).powi(2) + (s.y - fly.y).powi(2)).sqrt();
                if dist < 1.0 {
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
            let per_neuron = ((rate_hz / STIM_RATE_HZ) * SENSORY_SCALE * r).min(0.5) as f32;
            for &k in &self.sensory_indices {
                let idx = k as usize;
                if idx < self.n {
                    next[idx] += per_neuron;
                }
            }
        }

        for stim in pending {
            let strength = stim.strength.min(2.0) as f32;
            for id in stim.neuron_ids {
                if let Some(&idx) = self.id_to_idx.get(&id) {
                    let i = idx as usize;
                    if i < self.n {
                        next[i] += strength;
                    }
                }
            }
        }

        let mut activity_sparse = HashMap::new();
        for (i, v) in next.iter_mut().enumerate() {
            let val = (*v).clamp(0.0, ACTIVITY_MAX);
            let val = if val.is_finite() { val } else { 0.0 };
            *v = val;
            if val > ACTIVITY_THRESHOLD {
                if let Some(id) = self.neuron_ids.get(i) {
                    activity_sparse.insert(id.clone(), val.min(1.0) as f64);
                }
            }
        }

        if fly.rest_time_left > 0.0 {
            next.fill(0.0);
            activity_sparse.clear();
        }

        self.activity = next.clone();

        let mut ml = 0.0f64;
        let mut mr = 0.0f64;
        let mut mf = 0.0f64;
        for &i in &self.motor_left {
            let idx = i as usize;
            if idx < self.n {
                ml += self.activity[idx] as f64;
            }
        }
        for &i in &self.motor_right {
            let idx = i as usize;
            if idx < self.n {
                mr += self.activity[idx] as f64;
            }
        }
        for &i in &self.motor_unknown {
            let idx = i as usize;
            if idx < self.n {
                mf += self.activity[idx] as f64;
            }
        }

        (
            self.activity.clone(),
            activity_sparse,
            ml * MOTOR_SCALE,
            mr * MOTOR_SCALE,
            mf * MOTOR_SCALE,
        )
    }
}
