#!/usr/bin/env python3
"""
Calibrate Rust brain: drive sugar GRNs at 100 Hz (or NEUROSIM_CALIBRATION_SUGAR_HZ),
0.1 ms dt, 1 s. Report MN9 firing rate (Hz). Same protocol as calibrate_w_syn.py (Python).

Paper (Shiu et al. Nature 2024): ~90% MN9 at 100 Hz sugar; ±30% tolerance.

Same connectome as Python: both use 2025_Connectivity_783.parquet (Python also
uses 2025_Completeness_783.csv for neuron order; Rust builds neuron list from
parquet ID columns — same 138k IDs, so sugar GRN and MN9 are in both).

Usage:
  # Start Rust service first (loads full parquet from data/raw/2025_Connectivity_783.parquet by default).
  #   api/brain-sim-service/target/release/brain-service &
  python3 scripts/calibrate_rust_sugar.py

  # Tune MN9 rate: set NEUROSIM_W_SYN when starting the service (default 0.15 → ~485 Hz; 0.12 → ~438 Hz; Python target ~90 Hz).
  #   NEUROSIM_W_SYN=0.12 api/brain-sim-service/target/release/brain-service &
  NEUROSIM_CALIBRATION_SUGAR_HZ=100 NEUROSIM_CALIBRATION_DURATION_MS=1000 python3 scripts/calibrate_rust_sugar.py
"""
from __future__ import annotations

import json
import os
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def _default_socket_path() -> Path:
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        base = Path(runtime_dir)
    else:
        base = Path.home() / ".local" / "run"
    base.mkdir(parents=True, exist_ok=True)
    return base / "neurosim-brain.sock"


SOCKET_PATH = Path(
    os.environ.get(
        "NEUROSIM_BRAIN_SOCKET_RUST",
        os.environ.get("NEUROSIM_BRAIN_SOCKET", str(_default_socket_path())),
    )
)
DT_MS = 0.1
CALIBRATION_DURATION_MS = float(os.environ.get("NEUROSIM_CALIBRATION_DURATION_MS", "1000.0"))
SUGAR_HZ_CALIB = float(os.environ.get("NEUROSIM_CALIBRATION_SUGAR_HZ", "100.0"))


def load_benchmark_ids() -> tuple[list[str], list[str]]:
    path = ROOT / "data" / "sugar_grn_mn9_benchmark.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise RuntimeError(f"Benchmark ID file not found: {path} ({e})") from e
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Benchmark ID file is invalid JSON: {path} ({e})") from e
    except OSError as e:
        raise RuntimeError(f"Failed reading benchmark ID file: {path} ({e})") from e
    if not isinstance(data, dict):
        raise ValueError(f"Benchmark ID file must contain a JSON object: {path}")
    sugar_raw = data.get("sugar_grn_root_ids")
    mn9_raw = data.get("mn9_root_ids")
    if not isinstance(sugar_raw, list) or not isinstance(mn9_raw, list):
        raise ValueError(
            f"Benchmark ID file must contain list keys 'sugar_grn_root_ids' and 'mn9_root_ids': {path}"
        )
    sugar = [str(x) for x in sugar_raw]
    mn9 = [str(x) for x in mn9_raw]
    return sugar, mn9


def main() -> int:
    if not SOCKET_PATH.exists():
        print(f"Socket not found: {SOCKET_PATH}", file=sys.stderr)
        print("Start the Rust brain-service first (see script docstring).", file=sys.stderr)
        return 1

    sugar_ids, mn9_ids = load_benchmark_ids()
    n_steps = max(1, round(CALIBRATION_DURATION_MS / DT_MS))
    dt_sec = DT_MS / 1000.0
    stim_rates = {rid: SUGAR_HZ_CALIB for rid in sugar_ids}

    print(f"Sugar GRNs: {len(sugar_ids)}, MN9: {len(mn9_ids)}", flush=True)
    print(f"dt={DT_MS} ms, duration={CALIBRATION_DURATION_MS} ms (1 trial), Rust socket {SOCKET_PATH}", flush=True)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(600.0)
    try:
        sock.connect(str(SOCKET_PATH))
    except OSError as e:
        print(f"Connect failed: {e}", file=sys.stderr)
        return 1
    f = sock.makefile("rwb")
    try:
        f.write(b'{"method":"create","params":{}}\n')
        f.flush()
        try:
            create_line = f.readline()
            out = json.loads(create_line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, OSError) as e:
            sys.stderr.write(f"Failed to decode create response: {e}\n")
            return 1
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
                "count_neuron_ids": sugar_ids + mn9_ids,
            },
        }
        f.write((json.dumps(req) + "\n").encode("utf-8"))
        f.flush()
        try:
            line = f.readline()
            if not line:
                raise RuntimeError("socket closed")
            step = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, OSError, RuntimeError) as e:
            sys.stderr.write(f"Failed to decode run_steps response: {e}\n")
            return 1
        if step.get("error"):
            raise RuntimeError(step["error"])
    finally:
        f.close()
        sock.close()

    spike_counts = step.get("spike_counts") or {}
    mn9_spike_count = sum(int(spike_counts.get(rid, 0)) for rid in mn9_ids)
    sugar_fired = sum(1 for rid in sugar_ids if int(spike_counts.get(rid, 0)) > 0)
    mn9_fired = sum(1 for rid in mn9_ids if int(spike_counts.get(rid, 0)) > 0)
    duration_sec = n_steps * dt_sec
    rate = mn9_spike_count / duration_sec if duration_sec > 0 else 0.0

    wall_sec = step.get("wall_sec")
    if wall_sec is not None:
        print(f"  wall {wall_sec:.1f} s, {1000 * wall_sec / n_steps:.2f} ms/step", flush=True)
    print(f"  sugar IDs with spikes: {sugar_fired}/{len(sugar_ids)}, MN9 with spikes: {mn9_fired}/{len(mn9_ids)}", flush=True)
    print(f"MN9 rate at {SUGAR_HZ_CALIB} Hz sugar: {rate:.2f} Hz", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
