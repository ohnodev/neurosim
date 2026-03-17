# python-brain

Python simulation service for NeuroSim, using Fly-Brain model code as the runtime engine.

## Runtime

- Protocol: newline-delimited JSON over Unix socket
- Default socket: `/tmp/neurosim-brain.sock`
- Entrypoint: `service.py`

## Environment

- `NEUROSIM_BRAIN_SOCKET` (optional)
- `NEUROSIM_PYTHON_BRAIN_SEED` (optional, default deterministic seed)
- `NEUROSIM_PYTHON_BRAIN_DEVICE` (`cpu`, `cuda`, or `auto`; default `cpu`)
- `NEUROSIM_PYTHON_BRAIN_DT_MS` (default `0.1`)
- `FLY_BRAIN_DIR` (optional path to fly-brain repo; defaults to `../fly-brain`)

## Methods

- `ping`
- `create`
- `reset`
- `step`
- `step_many`

Response fields are shaped to match the existing API `brain-socket-client` expectations.
