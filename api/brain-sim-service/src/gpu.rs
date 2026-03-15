#![cfg(feature = "cuda")]

use cudarc::driver::safe::{CudaDevice, CudaSlice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::safe::compile_ptx;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Instant;

use crate::model_constants::{RECURRENT_SCALE, REFRACT_MS, TAU_MEM_MS, TAU_SYN_MS, V_RESET, V_REST, V_THRESH};

static DEVICE: OnceLock<Option<Arc<CudaDevice>>> = OnceLock::new();

const K: &str = r#"
extern "C" __global__ void decay_g_kernel(float* g, int N, float syn_decay) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) g[i] = g[i] * syn_decay;
}

extern "C" __global__ void recurrent_kernel(
    const unsigned char* spikes_prev,
    float* g,
    const unsigned int* ep, const unsigned int* epo, const float* ew,
    int ne, int N, float recurrent_scale
) {
    int e = blockIdx.x * blockDim.x + threadIdx.x;
    if (e >= ne) return;
    unsigned int pi = ep[e], po = epo[e];
    if (pi >= (unsigned)N || po >= (unsigned)N) return;
    if (spikes_prev[pi] == 0) return;
    float w = fminf(ew[e], 10.0f);
    atomicAdd(&g[po], w * recurrent_scale);
}

extern "C" __global__ void add_uniform_kernel(float* g, const unsigned int* idx, int n_idx, float val, int N) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n_idx) return;
    unsigned int k = idx[i];
    if (k < (unsigned)N) {
        atomicAdd(&g[k], val);
    }
}

extern "C" __global__ void lif_kernel(
    float* v,
    const float* g,
    unsigned short* refrac,
    unsigned char* spikes_next,
    int N,
    float mem_alpha,
    float v_rest,
    float v_reset,
    float v_thresh,
    unsigned short refrac_steps
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        if (refrac[i] > 0) {
            refrac[i] -= 1;
            v[i] = v_reset;
            spikes_next[i] = 0;
            return;
        }
        float v_next = v[i] + mem_alpha * (v_rest - v[i] + g[i]);
        if (!isfinite(v_next)) {
            v_next = v_rest;
        }
        if (v_next >= v_thresh) {
            v[i] = v_reset;
            refrac[i] = refrac_steps;
            spikes_next[i] = 1;
        } else {
            v[i] = v_next;
            spikes_next[i] = 0;
        }
    }
}
"#;

pub struct GpuStepResult {
    pub spikes: Vec<u8>,
    pub recurrent_ms: f64,
    pub lif_ms: f64,
}

pub struct GpuSimState {
    dev: Arc<CudaDevice>,
    n: usize,
    ne: usize,
    edge_pre: CudaSlice<u32>,
    edge_post: CudaSlice<u32>,
    edge_weight: CudaSlice<f32>,
    v: CudaSlice<f32>,
    g: CudaSlice<f32>,
    refrac: CudaSlice<u16>,
    spikes_prev: CudaSlice<u8>,
    spikes_next: CudaSlice<u8>,
    sensory_cache_indices: Vec<u32>,
    sensory_cache_dev: Option<CudaSlice<u32>>,
}

impl GpuSimState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        n: usize,
        edges_pre: &[u32],
        edges_post: &[u32],
        edges_weight: &[f32],
        v_init: &[f32],
        g_init: &[f32],
        refrac_init: &[u16],
        spikes_init: &[u8],
    ) -> Option<Self> {
        if edges_pre.len() != edges_post.len() || edges_pre.len() != edges_weight.len() {
            return None;
        }
        if v_init.len() != n || g_init.len() != n || refrac_init.len() != n || spikes_init.len() != n {
            return None;
        }
        let ne = edges_pre.len();
        let dev = DEVICE
            .get_or_init(|| {
                let d = CudaDevice::new(0).ok()?;
                let ptx = compile_ptx(K).ok()?;
                d.load_ptx(
                    ptx,
                    "bs",
                    &[
                        "decay_g_kernel",
                        "recurrent_kernel",
                        "add_uniform_kernel",
                        "lif_kernel",
                    ],
                )
                    .ok()?;
                Some(d)
            })
            .clone()?;
        let edge_pre = dev.htod_sync_copy(edges_pre).ok()?;
        let edge_post = dev.htod_sync_copy(edges_post).ok()?;
        let edge_weight = dev.htod_sync_copy(edges_weight).ok()?;
        let v = dev.htod_sync_copy(v_init).ok()?;
        let g = dev.htod_sync_copy(g_init).ok()?;
        let refrac = dev.htod_sync_copy(refrac_init).ok()?;
        let spikes_prev = dev.htod_sync_copy(spikes_init).ok()?;
        let spikes_next = dev.alloc_zeros(n).ok()?;
        Some(Self {
            ne,
            dev,
            n,
            edge_pre,
            edge_post,
            edge_weight,
            v,
            g,
            refrac,
            spikes_prev,
            spikes_next,
            sensory_cache_indices: Vec::new(),
            sensory_cache_dev: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        dt_sec: f32,
        sensory_indices: &[u32],
        sensory_strength: f32,
    ) -> Option<GpuStepResult> {
        if !dt_sec.is_finite() || dt_sec <= 0.0 {
            eprintln!(
                "[brain-service][gpu] invalid dt_sec={} (requires finite > 0); n={} ne={}",
                dt_sec, self.n, self.ne
            );
            return None;
        }
        let decay = self.dev.get_func("bs", "decay_g_kernel")?;
        let recurrent = self.dev.get_func("bs", "recurrent_kernel")?;
        let add_uniform = self.dev.get_func("bs", "add_uniform_kernel")?;
        let lif = self.dev.get_func("bs", "lif_kernel")?;
        let n = self.n as i32;
        let ne = self.ne as i32;
        let dt_ms = dt_sec * 1000.0;
        let syn_decay = (-dt_ms / TAU_SYN_MS).exp();
        let mem_alpha = dt_ms / TAU_MEM_MS;
        let refrac_steps = ((REFRACT_MS / dt_ms).ceil().max(1.0)) as u16;

        unsafe {
            decay
                .launch(LaunchConfig::for_num_elems(self.n as u32), (&mut self.g, n, syn_decay))
                .ok()?;
        }
        let t_recurrent = Instant::now();
        unsafe {
            recurrent.launch(
                LaunchConfig::for_num_elems(self.ne as u32),
                (
                    &self.spikes_prev,
                    &mut self.g,
                    &self.edge_pre,
                    &self.edge_post,
                    &self.edge_weight,
                    ne,
                    n,
                    RECURRENT_SCALE,
                ),
            )
            .ok()?;
        }
        let recurrent_ms = t_recurrent.elapsed().as_secs_f64() * 1000.0;
        if sensory_strength > 0.0 && !sensory_indices.is_empty() {
            if self.sensory_cache_indices.as_slice() != sensory_indices {
                self.sensory_cache_dev = Some(self.dev.htod_sync_copy(sensory_indices).ok()?);
                self.sensory_cache_indices = sensory_indices.to_vec();
            }
            let sensory_dev = self.sensory_cache_dev.as_ref()?;
            unsafe {
                add_uniform
                    .launch(
                        LaunchConfig::for_num_elems(sensory_indices.len() as u32),
                        (
                            &mut self.g,
                            sensory_dev,
                            sensory_indices.len() as i32,
                            sensory_strength,
                            n,
                        ),
                    )
                    .ok()?;
            }
        }
        let t_lif = Instant::now();
        unsafe {
            lif.launch(
                LaunchConfig::for_num_elems(self.n as u32),
                (
                    &mut self.v,
                    &self.g,
                    &mut self.refrac,
                    &mut self.spikes_next,
                    n,
                    mem_alpha,
                    // Intentional: this model uses v_rest == v_reset for direct
                    // reset to baseline after spikes/refractory.
                    V_REST,
                    V_RESET,
                    V_THRESH,
                    refrac_steps,
                ),
            )
            .ok()?;
        }
        let spikes = self.dev.dtoh_sync_copy(&self.spikes_next).ok()?;
        std::mem::swap(&mut self.spikes_prev, &mut self.spikes_next);
        let lif_ms = t_lif.elapsed().as_secs_f64() * 1000.0;
        Some(GpuStepResult {
            spikes,
            recurrent_ms,
            lif_ms,
        })
    }

    pub fn host_state(&self) -> Option<(Vec<f32>, Vec<f32>, Vec<u16>)> {
        let v = self.dev.dtoh_sync_copy(&self.v).ok()?;
        let g = self.dev.dtoh_sync_copy(&self.g).ok()?;
        let refrac = self.dev.dtoh_sync_copy(&self.refrac).ok()?;
        Some((v, g, refrac))
    }
}
