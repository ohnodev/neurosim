# NeuroSim vs fly-brain (CUDA) Comparison

## Setup

- NeuroSim connectome: `100000` neurons, `1788877` connections
- fly-brain connectome: `138639` neurons (project default)
- Both runs: `1 fly`, `dt=0.0001s` (0.1ms), `220` steps, `2` runs
- NeuroSim benchmark command:
  - `BENCH_RUNS=2 BENCH_STEPS=220 BENCH_DT=0.0001 node scripts/benchmark-brain-service.mjs`
- fly-brain benchmark command:
  - direct `run_single_benchmark(t_run=0.022, n_run=1)` in `brain-fly` env

## Results

### NeuroSim (Rust + CUDA spike-LIF core)

- Run 1
  - `client_avg_ms`: `0.552`
  - `compute_avg_ms`: `0.357`
  - `kernel_avg_ms`: `0.240`
  - `recurrent_avg_ms`: `0.138`
  - `lif_avg_ms`: `0.101`
  - `readout_avg_ms`: `0.116`
- Run 2
  - `client_avg_ms`: `0.524`
  - `compute_avg_ms`: `0.353`
  - `kernel_avg_ms`: `0.238`
  - `recurrent_avg_ms`: `0.135`
  - `lif_avg_ms`: `0.103`
  - `readout_avg_ms`: `0.113`

### fly-brain (PyTorch CUDA)

- Run 1
  - `sim_total_s`: `0.4079`
  - `ms/step`: `1.854`
- Run 2
  - `sim_total_s`: `0.3864`
  - `ms/step`: `1.756`
- Average `ms/step`: `1.805`

## Notes

- NeuroSim now exposes per-step timing splits through `step`/`step_many`:
  - `compute_ms`, `kernel_ms`, `recurrent_ms`, `lif_ms`, `readout_ms`
- `kernel_ms` excludes readout map/motor aggregation.
- Absolute comparisons still have caveats because connectome size and model details differ.
