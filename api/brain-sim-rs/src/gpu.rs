//! CUDA GPU acceleration for brain simulation step (decay + propagation).

use cudarc::driver::safe::{CudaDevice, CudaSlice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::safe::compile_ptx;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

static DEVICE: OnceLock<Option<Arc<CudaDevice>>> = OnceLock::new();

/// Shared connectome edge buffers — uploaded once, reused by all flies.
struct SharedEdges {
    edge_pre: CudaSlice<u32>,
    edge_post: CudaSlice<u32>,
    edge_weight: CudaSlice<f32>,
    n_edges: usize,
}

/// Global cache for SharedEdges. Holds edge buffers for the process lifetime.
/// Does not auto-invalidate on connectome changes; intended for single shared connectome.
/// To invalidate: replace with None or restart process.
static EDGE_CACHE: Mutex<Option<Arc<SharedEdges>>> = Mutex::new(None);

#[cfg(all(test, feature = "cuda"))]
fn clear_edge_cache_for_test() {
    if let Ok(mut cache) = EDGE_CACHE.lock() {
        *cache = None;
    }
}

fn get_or_create_shared_edges(
    device: &Arc<CudaDevice>,
    n: usize,
    adj: &[Vec<(u32, f32)>],
) -> Option<Arc<SharedEdges>> {
    let mut cache = EDGE_CACHE.lock().ok()?;
    if let Some(ref shared) = *cache {
        return Some(Arc::clone(shared));
    }
    let mut edge_pre = Vec::with_capacity(1024);
    let mut edge_post = Vec::with_capacity(1024);
    let mut edge_weight = Vec::with_capacity(1024);
    for (pre_idx, list) in adj.iter().enumerate() {
        for &(post_idx, weight) in list {
            if (post_idx as usize) < n {
                edge_pre.push(pre_idx as u32);
                edge_post.push(post_idx);
                edge_weight.push(weight.min(10.0));
            }
        }
    }
    let n_edges = edge_pre.len();
    let edge_pre_dev = device.htod_sync_copy(&edge_pre).ok()?;
    let edge_post_dev = device.htod_sync_copy(&edge_post).ok()?;
    let edge_weight_dev = device.htod_sync_copy(&edge_weight).ok()?;
    let shared = Arc::new(SharedEdges {
        edge_pre: edge_pre_dev,
        edge_post: edge_post_dev,
        edge_weight: edge_weight_dev,
        n_edges,
    });
    *cache = Some(Arc::clone(&shared));
    Some(shared)
}

const KERNEL_SRC: &str = r#"
/* Portable atomic add for float (works on all compute capabilities; native atomicAdd(float) needs SM 6.0+) */
__device__ static void atomic_add_float(float* addr, float val) {
    unsigned int* addr_as_ui = (unsigned int*)addr;
    unsigned int old = *addr_as_ui;
    unsigned int assumed;
    do {
        assumed = old;
        float sum = __uint_as_float(old) + val;
        old = atomicCAS(addr_as_ui, assumed, __float_as_uint(sum));
    } while (assumed != old);
}

extern "C" __global__ void decay_kernel(
    const float* activity,
    float* next,
    int n,
    float decay_factor
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        next[i] = activity[i] * decay_factor;
    }
}

extern "C" __global__ void propagate_kernel(
    const float* activity,
    float* next,
    const unsigned int* edge_pre,
    const unsigned int* edge_post,
    const float* edge_weight,
    int n_edges,
    float tau_r,
    float prop_cap_r
) {
    int e = blockIdx.x * blockDim.x + threadIdx.x;
    if (e >= n_edges) return;
    unsigned int pre_idx = edge_pre[e];
    unsigned int post_idx = edge_post[e];
    float w = fminf(edge_weight[e], 10.0f);
    float pre_act = activity[pre_idx];
    if (!isfinite(pre_act) || pre_act <= 0.0f) return;
    float v = fminf(pre_act * tau_r * w, prop_cap_r);
    if (isfinite(v)) {
        atomic_add_float(&next[post_idx], v);
    }
}

extern "C" __global__ void clamp_kernel(
    float* next,
    int n,
    float activity_max
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        float v = next[i];
        if (!isfinite(v)) v = 0.0f;
        next[i] = fminf(fmaxf(v, 0.0f), activity_max);
    }
}
"#;

fn get_device() -> Option<Arc<CudaDevice>> {
    DEVICE.get_or_init(|| {
        let dev = CudaDevice::new(0).ok()?;
        let ptx = compile_ptx(KERNEL_SRC).ok()?;
        dev.load_ptx(ptx, "brain_sim", &["decay_kernel", "propagate_kernel", "clamp_kernel"])
            .ok()?;
        Some(dev)
    }).clone()
}

pub struct GpuSimState {
    device: Arc<CudaDevice>,
    n: usize,
    n_edges: usize,
    activity: CudaSlice<f32>,
    next: CudaSlice<f32>,
    edges: Arc<SharedEdges>,
}

impl GpuSimState {
    pub fn new(
        n: usize,
        adj: &[Vec<(u32, f32)>],
        initial_activity: &[f32],
    ) -> Option<Self> {
        let device = get_device()?;
        let edges = get_or_create_shared_edges(&device, n, adj)?;
        let n_edges = edges.n_edges;

        let activity = device.htod_sync_copy(initial_activity).ok()?;
        let next = device.alloc_zeros(n).ok()?;

        Some(Self {
            device,
            n,
            n_edges,
            activity,
            next,
            edges,
        })
    }

    /// Run one step: decay + propagate + clamp. Caller passes current activity; we return new activity.
    pub fn step(
        &mut self,
        activity: &[f32],
        decay_factor: f32,
        tau_r: f32,
        prop_cap_r: f32,
        activity_max: f32,
    ) -> Option<Vec<f32>> {
        if activity.len() != self.n {
            eprintln!("[gpu] step failed: activity len {} != n {}", activity.len(), self.n);
            return None;
        }
        if let Err(e) = self.device.htod_sync_copy_into(activity, &mut self.activity) {
            eprintln!("[gpu] step failed: htod_sync_copy_into error: {:?}", e);
            return None;
        }

        let decay_fn = match self.device.get_func("brain_sim", "decay_kernel") {
            Some(f) => f,
            None => {
                eprintln!("[gpu] step failed: get_func decay_kernel returned None");
                return None;
            }
        };
        let prop_fn = match self.device.get_func("brain_sim", "propagate_kernel") {
            Some(f) => f,
            None => {
                eprintln!("[gpu] step failed: get_func propagate_kernel returned None");
                return None;
            }
        };
        let clamp_fn = match self.device.get_func("brain_sim", "clamp_kernel") {
            Some(f) => f,
            None => {
                eprintln!("[gpu] step failed: get_func clamp_kernel returned None");
                return None;
            }
        };

        let n = self.n as i32;
        let n_edges = self.n_edges as i32;

        let decay_cfg = LaunchConfig::for_num_elems(self.n as u32);
        let prop_cfg = LaunchConfig::for_num_elems(self.n_edges as u32);
        let clamp_cfg = LaunchConfig::for_num_elems(self.n as u32);

        unsafe {
            if let Err(e) = decay_fn.launch(
                decay_cfg,
                (&self.activity, &mut self.next, n, decay_factor),
            ) {
                eprintln!("[gpu] step failed: decay_kernel launch error: {:?}", e);
                return None;
            }
            if let Err(e) = prop_fn.launch(
                prop_cfg,
                (
                    &self.activity,
                    &mut self.next,
                    &self.edges.edge_pre,
                    &self.edges.edge_post,
                    &self.edges.edge_weight,
                    n_edges,
                    tau_r,
                    prop_cap_r,
                ),
            ) {
                eprintln!("[gpu] step failed: propagate_kernel launch error: {:?}", e);
                return None;
            }
            if let Err(e) = clamp_fn.launch(clamp_cfg, (&mut self.next, n, activity_max)) {
                eprintln!("[gpu] step failed: clamp_kernel launch error: {:?}", e);
                return None;
            }
        }

        match self.device.dtoh_sync_copy(&self.next) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("[gpu] step failed: dtoh_sync_copy error: {:?}", e);
                None
            }
        }
    }
}

#[cfg(all(test, feature = "cuda"))]
mod tests {
    use super::*;

    /// Minimal connectome: 8 neurons, a few edges.
    fn minimal_adj() -> Vec<Vec<(u32, f32)>> {
        vec![
            vec![(1, 0.5), (2, 0.3)], // 0 -> 1, 2
            vec![(2, 0.2)],
            vec![(3, 0.4)],
            vec![],
            vec![(5, 0.1)],
            vec![],
            vec![(7, 0.3)],
            vec![],
        ]
    }

    #[test]
    fn test_gpu_init_and_step_minimal() {
        let adj = minimal_adj();
        let n = adj.len();
        let activity: Vec<f32> = vec![0.1; n];
        let mut state = GpuSimState::new(n, &adj, &activity).expect("GPU init should succeed");
        let result = state.step(&activity, 0.975, 0.004, 0.0004, 0.5);
        assert!(result.is_some(), "step should succeed");
        let out = result.unwrap();
        assert_eq!(out.len(), n, "output len should match n");
        for v in &out {
            assert!(v.is_finite() && *v >= 0.0 && *v <= 0.5, "output should be finite and clamped");
        }
    }

    #[test]
    fn test_gpu_step_larger_connectome() {
        clear_edge_cache_for_test();
        let n: usize = 256;
        let mut adj: Vec<Vec<(u32, f32)>> = (0..n).map(|_| Vec::new()).collect();
        for i in 0..n.saturating_sub(1) {
            adj[i].push(((i + 1) as u32, 0.2));
        }
        adj[n - 1].push((0, 0.2));
        let activity: Vec<f32> = (0..n).map(|i| if i % 10 == 0 { 0.15 } else { 0.0 }).collect();
        let mut state = GpuSimState::new(n, &adj, &activity).expect("GPU init should succeed");
        let result = state.step(&activity, 0.975, 0.004, 0.0004, 0.5);
        assert!(result.is_some(), "step should succeed with 256 neurons");
        let out = result.unwrap();
        assert_eq!(out.len(), n);
    }
}
