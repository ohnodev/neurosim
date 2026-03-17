#!/usr/bin/env python3
"""
Calibrate: drive sugar GRNs at 100 Hz (or NEUROSIM_CALIBRATION_SUGAR_HZ), 0.1 ms dt,
1 trial of 1 s. Report MN9 firing rate (spikes in 1 s / 1 s = Hz).

Paper (Shiu et al. Nature 2024): "absolute firing rate predictions are unlikely to be accurate";
relative trends and circuit predictions matter. ±30% on rate is a reasonable tolerance.

Usage:
  python3 scripts/calibrate_w_syn.py
  NEUROSIM_CALIBRATION_SUGAR_HZ=100 NEUROSIM_CALIBRATION_DURATION_MS=1000 python3 scripts/calibrate_w_syn.py
"""
from __future__ import annotations

import json
import sys
import os
import socket
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_default_socket_dir = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / "neurosim"
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", str(_default_socket_dir / "neurosim-brain.sock")))

# Paper: 0.1 ms timestep, 1,000 ms per trial. We do 1 trial (paper does 30 and averages).
DT_MS = 0.1  # timestep in ms — must match paper and service NEUROSIM_PYTHON_BRAIN_DT_MS
CALIBRATION_DURATION_MS = float(os.environ.get("NEUROSIM_CALIBRATION_DURATION_MS", "1000.0"))
SUGAR_HZ_CALIB = float(os.environ.get("NEUROSIM_CALIBRATION_SUGAR_HZ", "100.0"))


def load_benchmark_ids() -> tuple[list[str], list[str]]:
    path = ROOT / "data" / "sugar_grn_mn9_benchmark.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    sugar = [str(x) for x in data["sugar_grn_root_ids"]]
    mn9 = [str(x) for x in data["mn9_root_ids"]]
    return sugar, mn9


def run_calibration_sweep(sugar_ids: list[str], mn9_ids: list[str], sugar_hz: float) -> float:
    """Drive sugar GRNs at sugar_hz Hz for CALIBRATION_DURATION_MS at 0.1 ms; one RPC (run_steps)."""
    n_steps = round(CALIBRATION_DURATION_MS / DT_MS)  # 1000 ms / 0.1 ms = 10000 steps
    dt_sec = DT_MS / 1000.0
    stim_rates = {rid: sugar_hz for rid in sugar_ids}

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(str(SOCKET_PATH))
    f = sock.makefile("rwb")
    try:
        f.write(b'{"method":"create","params":{}}\n')
        f.flush()
        out = json.loads(f.readline().decode("utf-8"))
        if out.get("error"):
            raise RuntimeError(out["error"])
        sim_id = int(out["sim_id"])

        req = {
            "method": "run_steps",
            "params": {
                "sim_id": sim_id,
                "num_steps": n_steps,
                "dt": dt_sec,
                "stim_rates_by_id": stim_rates,
                "count_neuron_ids": mn9_ids,
            },
        }
        f.write((json.dumps(req) + "\n").encode("utf-8"))
        f.flush()
        line = f.readline()
        if not line:
            raise RuntimeError("socket closed")
        step = json.loads(line.decode("utf-8"))
        if step.get("error"):
            raise RuntimeError(step["error"])
        spike_counts = step.get("spike_counts") or {}
        mn9_spike_count = sum(int(spike_counts.get(rid, 0)) for rid in mn9_ids)
        if step.get("wall_sec"):
            print(f"  wall {step['wall_sec']:.1f} s, {step.get('ms_per_step')} ms/step", flush=True)

        f.write(b'{"method":"reset","params":{}}\n')
        f.flush()
        f.readline()
    finally:
        f.close()
        sock.close()

    duration_sec = n_steps * dt_sec
    return mn9_spike_count / duration_sec if duration_sec > 0 else 0.0


def main() -> int:
    sugar_ids, mn9_ids = load_benchmark_ids()
    # Filter to IDs present in the brain (service will ignore missing)
    print(f"Sugar GRNs: {len(sugar_ids)}, MN9: {len(mn9_ids)}", flush=True)
    print(f"dt={DT_MS} ms, duration={CALIBRATION_DURATION_MS} ms (1 trial)", flush=True)
    sys.stdout.flush()
    sys.stderr.flush()

    print(f"Running {SUGAR_HZ_CALIB} Hz sugar sweep...", flush=True)
    rate = run_calibration_sweep(sugar_ids, mn9_ids, SUGAR_HZ_CALIB)
    print(f"MN9 rate at {SUGAR_HZ_CALIB} Hz sugar: {rate:.2f} Hz", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
