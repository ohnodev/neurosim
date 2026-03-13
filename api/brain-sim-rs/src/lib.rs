#![deny(clippy::all)]

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[cfg(feature = "cuda")]
mod gpu;

#[napi(object)]
pub struct ConnectionInput {
    pub pre: String,
    pub post: String,
    pub weight: Option<f64>,
}

const REF_STEP: f64 = 1.0 / 30.0;
const TAU: f64 = 0.004;
const DECAY: f64 = 0.975;
const PROP_CAP: f64 = 0.0004;
const STIM_RATE_HZ: f64 = 200.0;
const SENSORY_SCALE: f64 = 0.18;
const ACTIVITY_MAX: f32 = 0.5;
const MOTOR_SCALE: f64 = 0.002;

#[napi(object)]
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

#[napi(object)]
pub struct SourceInput {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
}

#[napi(object)]
pub struct PendingStimInput {
    pub neuron_ids: Vec<String>,
    pub strength: f64,
}

#[napi(object)]
pub struct StepResult {
    pub activity: Float32Array,
    pub motor_left: f64,
    pub motor_right: f64,
    pub motor_fwd: f64,
}

/// Adjacency: for each pre_idx, list of (post_idx, weight).
/// id_to_idx: neuron root_id -> index
#[napi]
pub struct BrainSim {
    n: usize,
    id_to_idx: HashMap<String, u32>,
    adj: Vec<Vec<(u32, f32)>>,
    sensory_indices: Vec<u32>,
    motor_left: Vec<u32>,
    motor_right: Vec<u32>,
    motor_unknown: Vec<u32>,
    activity: Vec<f32>,
    #[cfg(feature = "cuda")]
    gpu_state: Option<gpu::GpuSimState>,
}

#[napi]
impl BrainSim {
    #[napi(constructor)]
    pub fn new(
        neuron_ids: Vec<String>,
        connections: Vec<ConnectionInput>,
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
        for conn in connections {
            let pre = conn.pre.as_str();
            let post = conn.post.as_str();
            let weight = conn.weight.unwrap_or(1.0) as f32;
            if let (Some(&pre_idx), Some(&post_idx)) = (id_to_idx.get(pre), id_to_idx.get(post)) {
                let w = if weight >= 1.0 && weight.is_finite() {
                    weight
                } else {
                    1.0
                };
                adj[pre_idx as usize].push((post_idx, w));
            }
        }

        let activity = vec![0.0f32; n];

        #[cfg(feature = "cuda")]
        let gpu_state = gpu::GpuSimState::new(n, &adj, &activity);

        Self {
            n,
            id_to_idx,
            adj,
            sensory_indices,
            motor_left,
            motor_right,
            motor_unknown,
            activity,
            #[cfg(feature = "cuda")]
            gpu_state,
        }
    }

    fn run_step_cpu(&self, decay_factor: f32, tau_r: f32, prop_cap_r: f32) -> Vec<f32> {
        let mut next = vec![0.0f32; self.n];
        for i in 0..self.n {
            next[i] = self.activity[i] * decay_factor;
        }
        for (pre_idx, list) in self.adj.iter().enumerate() {
            let pre_act = self.activity[pre_idx];
            if !pre_act.is_finite() || pre_act <= 0.0 {
                continue;
            }
            for &(post_idx, weight) in list {
                let j = post_idx as usize;
                if j < self.n {
                    let w = weight.min(10.0);
                    let v = (pre_act * tau_r * w).min(prop_cap_r);
                    if v.is_finite() {
                        next[j] += v;
                    }
                }
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

    #[napi]
    pub fn step(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
        pending: Vec<PendingStimInput>,
    ) -> StepResult {
        let r = (dt / REF_STEP).clamp(0.1, 3.0);
        let decay_factor = DECAY.powf(r) as f32;
        let tau_r = (TAU * r) as f32;
        let prop_cap_r = (PROP_CAP * r) as f32;

        let mut next = self.run_step_cpu(decay_factor, tau_r, prop_cap_r);
        #[cfg(feature = "cuda")]
        if let Some(ref mut gpu) = self.gpu_state {
            if let Some(gpu_next) = gpu.step(
                &self.activity,
                decay_factor,
                tau_r,
                prop_cap_r,
                ACTIVITY_MAX,
            ) {
                next = gpu_next;
            }
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

        for v in &mut next {
            *v = (*v).clamp(0.0, ACTIVITY_MAX);
            if !v.is_finite() {
                *v = 0.0;
            }
        }

        if fly.rest_time_left > 0.0 {
            next.fill(0.0);
        }

        self.activity = next;

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

        let activity_out: Float32Array = self.activity.clone().into();

        StepResult {
            activity: activity_out,
            motor_left: ml * MOTOR_SCALE,
            motor_right: mr * MOTOR_SCALE,
            motor_fwd: mf * MOTOR_SCALE,
        }
    }

    #[napi]
    pub fn get_activity(&self) -> Float32Array {
        self.activity.clone().into()
    }

    #[napi(getter)]
    pub fn is_using_gpu(&self) -> bool {
        #[cfg(feature = "cuda")]
        {
            self.gpu_state.is_some()
        }
        #[cfg(not(feature = "cuda"))]
        {
            false
        }
    }
}
