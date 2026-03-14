# NeuroSim vs EonSystems fly-brain CUDA Benchmark

Date: 2026-03-14

## Executive summary

On matched step timing (`dt=0.1ms`) and matched run structure (`1 fly`, `220` steps, `10` runs), NeuroSim outperformed EonSystems fly-brain in this environment.

- NeuroSim (full connectome in this repo): `134,181` neurons
- fly-brain (full connectome in that repo): `138,639` neurons
- Neuron count parity: NeuroSim is `96.78%` of fly-brain size

Observed speed factors (fly-brain time divided by NeuroSim time):

- vs NeuroSim end-to-end client step time: `~1.99x`
- vs NeuroSim compute time: `~2.63x`
- vs NeuroSim kernel time: `~3.76x`

Interpretation: lower is faster for ms/step, so NeuroSim is faster by the factors above.

## Benchmark setup

### Hardware/runtime

- GPU: NVIDIA Tesla T4
- CUDA driver/runtime available in both projects

### Run configuration

- One simulated fly
- `dt = 0.0001s` (0.1ms)
- `220` steps per run
- `10` runs each

### Commands used

- NeuroSim:
  - `SUBSET_SIZE=0 npm run process-connectome`
  - `USE_CUDA=1 NEUROSIM_MODE=cuda .../brain-service`
  - `BENCH_RUNS=10 BENCH_STEPS=220 BENCH_DT=0.0001 node scripts/benchmark-brain-service.mjs`
- fly-brain:
  - `run_pytorch.run_single_benchmark(t_run=0.022, n_run=1)` repeated `10` times in `brain-fly` env

## Results

### NeuroSim (10 runs, full connectome in this repo)

- `client_avg_ms`: `0.8705`
- `client_median_ms`: `0.8618`
- `compute_avg_ms`: `0.6579`
- `compute_median_ms`: `0.6529`
- `kernel_avg_ms`: `0.4590`
- `kernel_median_ms`: `0.4584`

### fly-brain (10 runs)

- `step_avg_ms`: `1.7257`
- `step_median_ms`: `1.6932`

### Relative speedup (fly over NeuroSim ratio)

- `vs_client_avg`: `1.9884x`
- `vs_client_median`: `1.9711x`
- `vs_compute_avg`: `2.6317x`
- `vs_compute_median`: `2.5696x`
- `vs_kernel_avg`: `3.7619x`
- `vs_kernel_median`: `3.7082x`

## Scope and caveats

This benchmark is strong, but not a perfect scientific equivalence:

1. Connectome sizes are close but not identical (`134,181` vs `138,639`).
2. Internal neuron/synapse implementations differ across repos.
3. Metric naming differs (`fly-brain sim_time` vs NeuroSim `client/compute/kernel` splits).
4. This is single-GPU, single-machine evidence; independent replication is recommended.

## Review checklist before external publication

- [ ] Re-run both benchmarks from a clean reboot and capture raw logs
- [ ] Re-run on at least one additional GPU class
- [ ] Include confidence intervals or p95 statistics in the final public chart
- [ ] Add script-level artifact export (CSV + JSON + command metadata)
- [ ] Independent teammate rerun and sign-off

## Claim wording recommendation

Preferred claim:

`In our internal CUDA benchmark on Tesla T4 (1 fly, dt=0.1ms, 220 steps, 10 runs), NeuroSim achieved lower per-step latency than the EonSystems fly-brain reference by ~2.0x end-to-end and ~2.6x on compute-timed paths (with near-full connectome parity: 134,181 vs 138,639 neurons).`

Avoid absolute/universal claims without independent replication.
