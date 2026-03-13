#![cfg(feature = "cuda")]

use cudarc::driver::safe::{CudaDevice, CudaSlice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::safe::compile_ptx;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

static DEVICE: OnceLock<Option<Arc<CudaDevice>>> = OnceLock::new();
static EDGE_CACHE: Mutex<Option<Arc<SharedEdges>>> = Mutex::new(None);

struct SharedEdges {
    edge_pre: CudaSlice<u32>,
    edge_post: CudaSlice<u32>,
    edge_weight: CudaSlice<f32>,
    n_edges: usize,
}

fn get_edges(
    device: &Arc<CudaDevice>,
    n: usize,
    adj: &[Vec<(u32, f32)>],
) -> Option<Arc<SharedEdges>> {
    let mut cache = EDGE_CACHE.lock().ok()?;
    if let Some(ref s) = *cache {
        return Some(Arc::clone(s));
    }
    let mut ep = Vec::with_capacity(4096);
    let mut epo = Vec::with_capacity(4096);
    let mut ew = Vec::with_capacity(4096);
    for (pre, list) in adj.iter().enumerate() {
        for &(post, w) in list {
            if (post as usize) < n {
                ep.push(pre as u32);
                epo.push(post);
                ew.push(w.min(10.0));
            }
        }
    }
    let ne = ep.len();
    let ed = Arc::new(SharedEdges {
        edge_pre: device.htod_sync_copy(&ep).ok()?,
        edge_post: device.htod_sync_copy(&epo).ok()?,
        edge_weight: device.htod_sync_copy(&ew).ok()?,
        n_edges: ne,
    });
    *cache = Some(Arc::clone(&ed));
    Some(ed)
}

const K: &str = r#"
__device__ void af(float* a, float v) {
    unsigned int* u = (unsigned int*)a;
    unsigned int o = *u, as;
    do {
        as = o;
        o = atomicCAS(u, as, __float_as_uint(__uint_as_float(as) + v));
    } while (as != o);
}
extern "C" __global__ void decay_kernel(const float* a, float* n, int N, float d) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) n[i] = a[i] * d;
}
extern "C" __global__ void propagate_kernel(const float* a, float* n,
    const unsigned int* ep, const unsigned int* epo, const float* ew,
    int ne, int N, float tr, float pr) {
    int e = blockIdx.x * blockDim.x + threadIdx.x;
    if (e >= ne) return;
    unsigned int pi = ep[e], po = epo[e];
    if (pi >= (unsigned)N || po >= (unsigned)N) return;
    float w = fminf(ew[e], 10.0f), pa = a[pi];
    if (!isfinite(pa) || pa <= 0.0f) return;
    float v = fminf(pa * tr * w, pr);
    if (isfinite(v)) af(&n[po], v);
}
extern "C" __global__ void clamp_kernel(float* n, int N, float m) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        float v = n[i];
        n[i] = fminf(fmaxf(isfinite(v) ? v : 0.0f, 0.0f), m);
    }
}
"#;

pub struct GpuSimState {
    dev: Arc<CudaDevice>,
    n: usize,
    ne: usize,
    act: CudaSlice<f32>,
    nxt: CudaSlice<f32>,
    edges: Arc<SharedEdges>,
}

impl GpuSimState {
    pub fn new(n: usize, adj: &[Vec<(u32, f32)>], init: &[f32]) -> Option<Self> {
        let dev = DEVICE
            .get_or_init(|| {
                let d = CudaDevice::new(0).ok()?;
                let ptx = compile_ptx(K).ok()?;
                d.load_ptx(ptx, "bs", &["decay_kernel", "propagate_kernel", "clamp_kernel"])
                    .ok()?;
                Some(d)
            })
            .clone()?;
        let edges = get_edges(&dev, n, adj)?;
        let act = dev.htod_sync_copy(init).ok()?;
        let nxt = dev.alloc_zeros(n).ok()?;
        Some(Self {
            ne: edges.n_edges,
            dev,
            n,
            act,
            nxt,
            edges,
        })
    }

    pub fn step(
        &mut self,
        a: &[f32],
        df: f32,
        tr: f32,
        pr: f32,
        max: f32,
    ) -> Option<Vec<f32>> {
        if a.len() != self.n {
            return None;
        }
        self.dev.htod_sync_copy_into(a, &mut self.act).ok()?;
        let decay = self.dev.get_func("bs", "decay_kernel")?;
        let prop = self.dev.get_func("bs", "propagate_kernel")?;
        let clamp = self.dev.get_func("bs", "clamp_kernel")?;
        let n = self.n as i32;
        let ne = self.ne as i32;
        unsafe {
            decay
                .launch(LaunchConfig::for_num_elems(self.n as u32), (&self.act, &mut self.nxt, n, df))
                .ok()?;
            prop.launch(
                LaunchConfig::for_num_elems(self.ne as u32),
                (
                    &self.act,
                    &mut self.nxt,
                    &self.edges.edge_pre,
                    &self.edges.edge_post,
                    &self.edges.edge_weight,
                    ne,
                    n,
                    tr,
                    pr,
                ),
            )
            .ok()?;
            clamp
                .launch(LaunchConfig::for_num_elems(self.n as u32), (&mut self.nxt, n, max))
                .ok()?;
        }
        self.dev.dtoh_sync_copy(&self.nxt).ok()
    }
}
