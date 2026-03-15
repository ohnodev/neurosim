//! Spike-based LIF simulation logic (CPU + optional GPU).
use std::collections::HashMap;
use std::time::Instant;

#[cfg(feature = "cuda")]
use crate::gpu::{GpuSimState, GpuStepResult};
use crate::model_constants::{
    RECURRENT_SCALE, REFRACT_MS, TAU_MEM_MS, TAU_SYN_MS, V_RESET, V_REST, V_THRESH,
};

const STIM_RATE_HZ: f64 = 200.0;
const SENSORY_SCALE: f64 = 0.18;
const ACTIVITY_THRESHOLD: u8 = 1;
const MOTOR_SCALE: f64 = 0.002;
const ARENA: f64 = 24.0;
const WALL_MARGIN: f64 = 6.0;
const FLY_TIME_MAX: f64 = 6.0;
const REST_TIME: f64 = 4.0;
const GROUND_Z: f64 = 0.35;
const FLIGHT_Z: f64 = 1.5;
const ON_GROUND_THRESH: f64 = 0.6;
const EAT_RADIUS: f64 = 2.5;
const NEAR_FOOD_RADIUS: f64 = 3.2;
const ODOR_DETECTION_RADIUS: f64 = 24.0;
const HUNGER_DECAY: f64 = 0.8;
const HEALTH_DECAY: f64 = 2.5;
const MOVE_SPEED: f64 = 41.0;
const BASELINE_EXPLORE: f64 = 0.03;
const FEEDING_STIM_BONUS: f32 = 0.25;
// Ignore near-zero food distance to avoid singular-like gain when the fly is
// effectively at the food source (handled separately by consumption logic).
const MIN_FOOD_DISTANCE: f64 = 1.0;

pub struct BrainSim {
    n: usize,
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
    v: Vec<f32>,
    g: Vec<f32>,
    refractory: Vec<u16>,
    spikes: Vec<u8>,
    viewer_indices: Vec<u32>,
    max_activity_entries: usize,
    fly_time_left_sec: f64,
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
    pub dead: bool,
}

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
    left: f32,
    right: f32,
    center: f32,
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
        sensory_left_indices: Vec<u32>,
        sensory_right_indices: Vec<u32>,
        sensory_unknown_indices: Vec<u32>,
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
            sensory_left_indices,
            sensory_right_indices,
            sensory_unknown_indices,
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
        sensory_left_indices: Vec<u32>,
        sensory_right_indices: Vec<u32>,
        sensory_unknown_indices: Vec<u32>,
        motor_left: Vec<u32>,
        motor_right: Vec<u32>,
        motor_unknown: Vec<u32>,
        viewer_indices: Vec<u32>,
    ) -> Self {
        if edges_pre.len() != edges_post.len() || edges_pre.len() != edges_weight.len() {
            panic!(
                "mismatched edge vector lengths: edges_pre={}, edges_post={}, edges_weight={}",
                edges_pre.len(),
                edges_post.len(),
                edges_weight.len()
            );
        }
        let n = neuron_ids.len();
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
            edges_pre,
            edges_post,
            edges_weight,
            sensory_indices,
            sensory_left_indices,
            sensory_right_indices,
            sensory_unknown_indices,
            motor_left,
            motor_right,
            motor_unknown,
            v,
            g,
            refractory,
            spikes,
            viewer_indices: sanitized_viewer,
            max_activity_entries,
            fly_time_left_sec: FLY_TIME_MAX,
            #[cfg(feature = "cuda")]
            gpu_state,
            #[cfg(feature = "cuda")]
            cuda_only,
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

    fn sensory_drive(&self, dt: f64, fly: &FlyInput, sources: &[SourceInput]) -> SensoryDrive {
        if self.sensory_indices.is_empty() {
            return SensoryDrive {
                left: 0.0,
                right: 0.0,
                center: 0.0,
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
            left_modulation += intensity * (0.25 + 0.75 * leftness);
            right_modulation += intensity * (0.25 + 0.75 * rightness);
            center_modulation += intensity * (1.0 - 0.4 * lateral.abs());
        }
        let to_strength = |modulation: f64| -> f32 {
            let rate_hz = if hungry && modulation > 0.0 {
                (50.0 + modulation * STIM_RATE_HZ).min(STIM_RATE_HZ)
            } else if full {
                30.0
            } else {
                50.0
            };
            let base = ((rate_hz / STIM_RATE_HZ) * SENSORY_SCALE * (dt / (1.0 / 30.0))).min(0.5) as f32;
            if near_food {
                (base + FEEDING_STIM_BONUS).min(1.0)
            } else {
                base
            }
        };
        SensoryDrive {
            left: to_strength(left_modulation),
            right: to_strength(right_modulation),
            center: to_strength(center_modulation),
        }
    }

    fn run_step_cpu(
        &mut self,
        dt: f64,
        fly: &FlyInput,
        sources: &[SourceInput],
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
        let sensory = self.sensory_drive(dt, fly, sources);
        if sensory.left > 0.0 {
            for &idx in &self.sensory_left_indices {
                let i = idx as usize;
                if i < self.n {
                    self.g[i] += sensory.left;
                }
            }
        }
        if sensory.right > 0.0 {
            for &idx in &self.sensory_right_indices {
                let i = idx as usize;
                if i < self.n {
                    self.g[i] += sensory.right;
                }
            }
        }
        let unknown_strength = ((sensory.left + sensory.right + sensory.center) / 3.0).max(0.0);
        if unknown_strength > 0.0 {
            for &idx in &self.sensory_unknown_indices {
                let i = idx as usize;
                if i < self.n {
                    self.g[i] += unknown_strength;
                }
            }
        }
        if self.sensory_left_indices.is_empty()
            && self.sensory_right_indices.is_empty()
            && self.sensory_unknown_indices.is_empty()
        {
            let fallback = sensory.center.max(sensory.left.max(sensory.right));
            if fallback > 0.0 {
                for &idx in &self.sensory_indices {
                    let i = idx as usize;
                    if i < self.n {
                        self.g[i] += fallback;
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
    ) -> (Vec<f32>, HashMap<String, f64>, f64, f64, f64, StepTiming, FlyStepOutput) {
        self.step_with_options(dt, fly, sources, true)
    }

    pub fn step_with_options(
        &mut self,
        dt: f64,
        fly: FlyInput,
        sources: Vec<SourceInput>,
        include_activity: bool,
    ) -> (Vec<f32>, HashMap<String, f64>, f64, f64, f64, StepTiming, FlyStepOutput) {
        let t_compute = Instant::now();
        let (recurrent_ms, lif_ms) = {
            #[cfg(feature = "cuda")]
            {
                let sensory = self.sensory_drive(dt, &fly, &sources);
                let sensory_strength = ((sensory.left + sensory.right + sensory.center) / 3.0).max(0.0);
                if let Some(ref mut gpu) = self.gpu_state {
                    match gpu.step(dt as f32, &self.sensory_indices, sensory_strength) {
                        Some(GpuStepResult {
                            spikes,
                            recurrent_ms,
                            lif_ms,
                        }) => {
                            if let Some((v, g, refractory)) = gpu.host_state() {
                                self.v = v;
                                self.g = g;
                                self.refractory = refractory;
                            } else if self.cuda_only {
                                panic!("[brain-service] CUDA required but GPU state sync failed");
                            } else {
                                eprintln!(
                                    "[brain-service] GPU host_state sync failed; keeping GPU authoritative and retaining gpu_state"
                                );
                            }
                            self.spikes = spikes;
                            (recurrent_ms, lif_ms)
                        }
                        None if self.cuda_only => {
                            panic!("[brain-service] CUDA required but GPU step failed")
                        }
                        None => {
                            panic!(
                                "[brain-service] GPU step failed; refusing CPU execution without authoritative GPU state sync"
                            );
                        }
                    }
                } else if self.cuda_only {
                    panic!("[brain-service] CUDA required but GPU unavailable");
                } else {
                    self.run_step_cpu(dt, &fly, &sources)
                }
            }
            #[cfg(not(feature = "cuda"))]
            {
                self.run_step_cpu(dt, &fly, &sources)
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

            let turn_from_motor = mr * MOTOR_SCALE - ml * MOTOR_SCALE;
            let forward_from_motor = ml * MOTOR_SCALE + mr * MOTOR_SCALE + mf * MOTOR_SCALE;
            let motor = forward_from_motor.tanh() * 0.5;

            let mut heading_bias = turn_from_motor * dt;
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
            fly_out,
        )
    }
}
