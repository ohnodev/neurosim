#![cfg(feature = "cuda")]
//! Full GPU-accelerated LIF pipeline: recurrent propagation, synaptic delay,
//! conductance update, LIF integration, forced spikes — all on device.
//! Poisson sensory input is computed on CPU and uploaded per step.

use cudarc::driver::safe::{CudaDevice, CudaSlice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::safe::compile_ptx;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Instant;

use crate::connectome::ConnectomeTemplate;
use crate::model_constants::{REFRACT_MS, TAU_MEM_MS, TAU_SYN_MS, V_RESET, V_REST, V_THRESH};

static DEVICE: OnceLock<Option<Arc<CudaDevice>>> = OnceLock::new();
static GPU_CONNECTOME: OnceLock<Option<Arc<GpuConnectome>>> = OnceLock::new();

const KERNELS: &str = r#"
extern "C" __global__ void clear_kernel(float* arr, int N) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) arr[i] = 0.0f;
}

extern "C" __global__ void compact_spikes_kernel(
    const unsigned char* spikes_prev,
    unsigned int* active_indices,
    int* num_active,
    int N
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N || spikes_prev[i] == 0) return;
    int pos = atomicAdd(num_active, 1);
    active_indices[pos] = (unsigned int)i;
}

extern "C" __global__ void csr_scatter_kernel(
    const unsigned int* active_indices,
    int num_active,
    const unsigned int* out_offsets,
    const unsigned int* out_post,
    const float* out_weight,
    const unsigned char* is_epg,
    float* syn_input,
    int N,
    float w_syn,
    float epg_recurrence_boost
) {
    int active_idx = blockIdx.x;
    if (active_idx >= num_active) return;
    unsigned int pre = active_indices[active_idx];
    unsigned int start = out_offsets[pre];
    unsigned int end = out_offsets[pre + 1];
    int pre_is_epg = is_epg[pre];
    for (unsigned int e = threadIdx.x; e < (end - start); e += blockDim.x) {
        unsigned int j = start + e;
        unsigned int post = out_post[j];
        if (post >= (unsigned int)N) continue;
        float w = out_weight[j];
        if (epg_recurrence_boost != 1.0f && pre_is_epg && is_epg[post]) {
            w *= epg_recurrence_boost;
        }
        atomicAdd(&syn_input[post], w * w_syn);
    }
}

extern "C" __global__ void add_syn_input_kernel(
    float* syn_input_dev,
    const float* syn_input_host,
    int N
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) syn_input_dev[i] += syn_input_host[i];
}

extern "C" __global__ void delay_conductance_kernel(
    const float* g,
    float* g_next,
    float* delay_buffer,
    const float* syn_input,
    const unsigned short* refractory,
    int N,
    int delay_base,
    float syn_decay
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N) return;
    int idx = delay_base + i;
    float delayed = delay_buffer[idx];
    float refrac_mask = (refractory[i] > 0) ? 0.0f : 1.0f;
    g_next[i] = g[i] * syn_decay + delayed * refrac_mask;
    delay_buffer[idx] = syn_input[i];
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
    if (i >= N) return;
    if (refrac[i] > 0) {
        refrac[i] -= 1;
        v[i] = v_reset;
        spikes_next[i] = 0;
        return;
    }
    float v_next = v[i] + mem_alpha * (v_rest - v[i] + g[i]);
    if (!isfinite(v_next)) v_next = v_rest;
    if (v_next >= v_thresh) {
        v[i] = v_reset;
        refrac[i] = refrac_steps;
        spikes_next[i] = 1;
    } else {
        v[i] = v_next;
        spikes_next[i] = 0;
    }
}

extern "C" __global__ void reset_g_on_spike_kernel(
    float* g_next,
    const unsigned char* spikes_next,
    int N
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N && spikes_next[i] > 0) g_next[i] = 0.0f;
}

extern "C" __global__ void apply_forced_spikes_kernel(
    float* v,
    unsigned short* refrac,
    float* g_next,
    unsigned char* spikes_next,
    const unsigned int* forced_indices,
    int num_forced,
    float v_reset,
    unsigned short refrac_steps
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= num_forced) return;
    unsigned int idx = forced_indices[i];
    spikes_next[idx] = 1;
    v[idx] = v_reset;
    refrac[idx] = refrac_steps;
    g_next[idx] = 0.0f;
}
"#;

/// Shared read-only connectome data on GPU (uploaded once at startup, reused by all sims).
pub struct GpuConnectome {
    dev: Arc<CudaDevice>,
    pub ne: usize,
    pub n: usize,
    is_epg: CudaSlice<u8>,
    out_offsets: CudaSlice<u32>,
    out_post: CudaSlice<u32>,
    out_weight: CudaSlice<f32>,
}

// CudaSlice wraps a device pointer — no host-side aliasing issues across threads.
unsafe impl Send for GpuConnectome {}
unsafe impl Sync for GpuConnectome {}

/// Per-sim GPU state: voltage, conductance, spikes, delay buffer.
pub struct GpuSimState {
    connectome: Arc<GpuConnectome>,
    n: usize,
    v: CudaSlice<f32>,
    g: CudaSlice<f32>,
    g_next: CudaSlice<f32>,
    syn_input: CudaSlice<f32>,
    delay_buffer: CudaSlice<f32>,
    refrac: CudaSlice<u16>,
    spikes_prev: CudaSlice<u8>,
    spikes_next: CudaSlice<u8>,
    delay_head: usize,
    delay_len: usize,
    syn_input_host_dev: CudaSlice<f32>,
    spikes_host: Vec<u8>,
    active_indices: CudaSlice<u32>,
    num_active: CudaSlice<i32>,
}

pub fn try_init_device() -> Option<Arc<CudaDevice>> {
    DEVICE
        .get_or_init(|| {
            let d = CudaDevice::new(0).ok()?;
            let ptx = compile_ptx(KERNELS).ok()?;
            d.load_ptx(
                ptx,
                "bs",
                &[
                    "clear_kernel",
                    "compact_spikes_kernel",
                    "csr_scatter_kernel",
                    "add_syn_input_kernel",
                    "delay_conductance_kernel",
                    "lif_kernel",
                    "reset_g_on_spike_kernel",
                    "apply_forced_spikes_kernel",
                ],
            )
            .ok()?;
            Some(d)
        })
        .clone()
}

/// Upload connectome CSR data to GPU once. Called from main() after loading the template.
pub fn init_gpu_connectome(template: &ConnectomeTemplate) -> Option<Arc<GpuConnectome>> {
    GPU_CONNECTOME
        .get_or_init(|| {
            let dev = try_init_device()?;
            let t0 = Instant::now();
            let is_epg = dev.htod_sync_copy(&template.is_epg).ok()?;
            let out_offsets = dev.htod_sync_copy(&template.out_offsets).ok()?;
            let out_post = dev.htod_sync_copy(&template.out_post).ok()?;
            let out_weight = dev.htod_sync_copy(&template.out_weight).ok()?;
            let upload_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let ne = template.edges_pre.len();
            let n = template.neuron_ids.len();
            let mem_mb = ((n + 1) * 4 + ne * (4 + 4) + n) as f64 / 1_048_576.0;
            eprintln!(
                "[brain-service][gpu] connectome uploaded (CSR): {} neurons, {} edges, {:.1} MB, {:.1}ms",
                n, ne, mem_mb, upload_ms
            );
            Some(Arc::new(GpuConnectome {
                dev,
                ne,
                n,
                is_epg,
                out_offsets,
                out_post,
                out_weight,
            }))
        })
        .clone()
}

pub fn get_gpu_connectome() -> Option<Arc<GpuConnectome>> {
    GPU_CONNECTOME.get().and_then(|opt| opt.clone())
}

impl GpuSimState {
    pub fn new(
        n: usize,
        connectome: Arc<GpuConnectome>,
        v_init: &[f32],
        g_init: &[f32],
        refrac_init: &[u16],
        spikes_init: &[u8],
        delay_len: usize,
    ) -> Option<Self> {
        let dev = &connectome.dev;
        let v = dev.htod_sync_copy(v_init).ok()?;
        let g = dev.htod_sync_copy(g_init).ok()?;
        let g_next: CudaSlice<f32> = dev.alloc_zeros(n).ok()?;
        let syn_input: CudaSlice<f32> = dev.alloc_zeros(n).ok()?;
        let delay_buffer: CudaSlice<f32> = dev.alloc_zeros(n * delay_len).ok()?;
        let refrac = dev.htod_sync_copy(refrac_init).ok()?;
        let spikes_prev = dev.htod_sync_copy(spikes_init).ok()?;
        let spikes_next: CudaSlice<u8> = dev.alloc_zeros(n).ok()?;
        let syn_input_host_dev: CudaSlice<f32> = dev.alloc_zeros(n).ok()?;
        let spikes_host = vec![0u8; n];
        let active_indices: CudaSlice<u32> = dev.alloc_zeros(n).ok()?;
        let num_active: CudaSlice<i32> = dev.alloc_zeros(1).ok()?;
        Some(Self {
            connectome,
            n,
            v,
            g,
            g_next,
            syn_input,
            delay_buffer,
            refrac,
            spikes_prev,
            spikes_next,
            delay_head: 0,
            delay_len,
            syn_input_host_dev,
            spikes_host,
            active_indices,
            num_active,
        })
    }

    /// Run one full simulation tick on GPU.
    ///
    /// `syn_input_host` — CPU-computed Poisson/stim additions (added on top of
    /// recurrent input computed by the GPU).
    /// `forced_indices` — neuron indices to force-spike (already resolved from IDs).
    ///
    /// Returns `(recurrent_ms, lif_ms)`. Spikes are in `last_spikes()`.
    pub fn step(
        &mut self,
        dt_sec: f64,
        syn_input_host: &[f32],
        w_syn: f32,
        epg_recurrence_boost: f32,
        forced_indices: &[u32],
    ) -> Option<(f64, f64)> {
        let dt_ms = (dt_sec * 1000.0) as f32;
        let syn_decay = 1.0f32 - dt_ms / TAU_SYN_MS;
        let mem_alpha = dt_ms / TAU_MEM_MS;
        let refrac_steps = ((REFRACT_MS / dt_ms).ceil().max(1.0)) as u16;
        let n = self.n as i32;
        let delay_base = (self.delay_head * self.n) as i32;

        let conn = Arc::clone(&self.connectome);
        let dev = &conn.dev;

        // 1. Clear syn_input
        let clear_fn = dev.get_func("bs", "clear_kernel")?;
        unsafe {
            clear_fn
                .launch(
                    LaunchConfig::for_num_elems(self.n as u32),
                    (&mut self.syn_input, n),
                )
                .ok()?;
        }

        let t_recurrent = Instant::now();

        // 2. Stream compaction: find spiking neuron indices (~60 out of 138K)
        dev.htod_sync_copy_into(&[0i32], &mut self.num_active).ok()?;
        let compact_fn = dev.get_func("bs", "compact_spikes_kernel")?;
        unsafe {
            compact_fn
                .launch(
                    LaunchConfig::for_num_elems(self.n as u32),
                    (&self.spikes_prev, &mut self.active_indices, &mut self.num_active, n),
                )
                .ok()?;
        }

        // 3. Upload CPU Poisson input (syncs GPU, so compact_spikes is done after this)
        dev.htod_sync_copy_into(syn_input_host, &mut self.syn_input_host_dev).ok()?;

        // Download spike count (compact already finished from the sync above)
        let mut count_host = [0i32];
        dev.dtoh_sync_copy_into(&self.num_active, &mut count_host).ok()?;
        let num_active = count_host[0].max(0) as u32;

        // 4. CSR scatter: one block per spiking neuron, 128 threads iterate its edges
        if num_active > 0 {
            let scatter_fn = dev.get_func("bs", "csr_scatter_kernel")?;
            let cfg = LaunchConfig {
                grid_dim: (num_active, 1, 1),
                block_dim: (128, 1, 1),
                shared_mem_bytes: 0,
            };
            unsafe {
                scatter_fn
                    .launch(
                        cfg,
                        (
                            &self.active_indices,
                            num_active as i32,
                            &conn.out_offsets,
                            &conn.out_post,
                            &conn.out_weight,
                            &conn.is_epg,
                            &mut self.syn_input,
                            n,
                            w_syn,
                            epg_recurrence_boost,
                        ),
                    )
                    .ok()?;
            }
        }

        // 5. Add CPU-computed Poisson / stim_rates_by_id additions
        let add_fn = dev.get_func("bs", "add_syn_input_kernel")?;
        unsafe {
            add_fn
                .launch(
                    LaunchConfig::for_num_elems(self.n as u32),
                    (&mut self.syn_input, &self.syn_input_host_dev, n),
                )
                .ok()?;
        }

        let recurrent_ms = t_recurrent.elapsed().as_secs_f64() * 1000.0;
        let t_lif = Instant::now();

        // 6. Delay buffer + conductance update (matches CPU alpha-synapse with 1.8ms delay)
        let delay_fn = dev.get_func("bs", "delay_conductance_kernel")?;
        unsafe {
            delay_fn
                .launch(
                    LaunchConfig::for_num_elems(self.n as u32),
                    (
                        &self.g,
                        &mut self.g_next,
                        &mut self.delay_buffer,
                        &self.syn_input,
                        &self.refrac,
                        n,
                        delay_base,
                        syn_decay,
                    ),
                )
                .ok()?;
        }
        self.delay_head = (self.delay_head + 1) % self.delay_len;

        // 7. LIF integration — uses OLD g (not g_next), matching CPU Euler scheme
        let lif_fn = dev.get_func("bs", "lif_kernel")?;
        unsafe {
            lif_fn
                .launch(
                    LaunchConfig::for_num_elems(self.n as u32),
                    (
                        &mut self.v,
                        &self.g,
                        &mut self.refrac,
                        &mut self.spikes_next,
                        n,
                        mem_alpha,
                        V_REST,
                        V_RESET,
                        V_THRESH,
                        refrac_steps,
                    ),
                )
                .ok()?;
        }

        // 8. Reset g_next for neurons that just spiked
        let reset_fn = dev.get_func("bs", "reset_g_on_spike_kernel")?;
        unsafe {
            reset_fn
                .launch(
                    LaunchConfig::for_num_elems(self.n as u32),
                    (&mut self.g_next, &self.spikes_next, n),
                )
                .ok()?;
        }

        // 9. Apply forced spikes on device
        if !forced_indices.is_empty() {
            let forced_dev = dev.htod_sync_copy(forced_indices).ok()?;
            let forced_fn = dev.get_func("bs", "apply_forced_spikes_kernel")?;
            unsafe {
                forced_fn
                    .launch(
                        LaunchConfig::for_num_elems(forced_indices.len() as u32),
                        (
                            &mut self.v,
                            &mut self.refrac,
                            &mut self.g_next,
                            &mut self.spikes_next,
                            &forced_dev,
                            forced_indices.len() as i32,
                            V_RESET,
                            refrac_steps,
                        ),
                    )
                    .ok()?;
            }
        }

        // 10. Download spikes into pre-allocated host buffer (no allocation)
        dev.dtoh_sync_copy_into(&self.spikes_next, &mut self.spikes_host).ok()?;
        let lif_ms = t_lif.elapsed().as_secs_f64() * 1000.0;

        // 11. Swap device handles: spikes_prev ← spikes_next, g ← g_next
        std::mem::swap(&mut self.spikes_prev, &mut self.spikes_next);
        std::mem::swap(&mut self.g, &mut self.g_next);

        Some((recurrent_ms, lif_ms))
    }

    pub fn last_spikes(&self) -> &[u8] {
        &self.spikes_host
    }

    pub fn ensure_delay_len(&mut self, new_delay_len: usize) {
        if self.delay_len == new_delay_len {
            return;
        }
        if let Ok(buf) = self.connectome.dev.alloc_zeros::<f32>(self.n * new_delay_len) {
            self.delay_buffer = buf;
            self.delay_head = 0;
            self.delay_len = new_delay_len;
        }
    }

    /// Push host spikes into device spikes_prev (used when step_with_options
    /// zeros spikes during fly rest periods).
    pub fn sync_spikes_from_host(&mut self, spikes: &[u8]) {
        if let Ok(s) = self.connectome.dev.htod_sync_copy(spikes) {
            self.spikes_prev = s;
        }
    }
}
