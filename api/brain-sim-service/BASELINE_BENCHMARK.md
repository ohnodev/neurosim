# Brain Service Baseline Benchmark

Branch baseline for spike-LIF CUDA migration (`feat/spike-lif-cuda-core`).

## Configuration

- Connectome: `100000` neurons, `1788877` connections
- Transport: Unix socket, `step_many` with `sims=1`
- Fly count: `1`
- Runs: `2`
- Requests per run: `220`
- `dt`: `0.0001s` (0.1ms)

## Client-side latency (end-to-end)

- Run 1: `40.52 ms/request` (`8914.68 ms` total)
- Run 2: `39.91 ms/request` (`8780.00 ms` total)

## Service-side sampled timings

Sampled from step logs every 20 requests.

- Run 1
  - `compute_avg_ms`: `35.5`
  - `kernel_avg_ms`: `34.0`
  - `post_avg_ms`: `1.0`
  - `serialize_avg_ms`: `0.4`
  - `total_avg_ms`: `36.2`
- Run 2
  - `compute_avg_ms`: `35.6`
  - `kernel_avg_ms`: `33.9`
  - `post_avg_ms`: `1.1`
  - `serialize_avg_ms`: `0.4`
  - `total_avg_ms`: `36.3`

These values are the frozen baseline to compare against each migration phase.
