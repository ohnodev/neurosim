#!/usr/bin/env python3
"""
Run 100 steps at 0.1 ms dt against the Rust brain service and print wall time.
Start the Rust service first (see calibrate_rust_sugar.py for how).
"""
from __future__ import annotations

import json
import os
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOCKET_PATH = Path(
    os.environ.get("NEUROSIM_BRAIN_SOCKET", "/tmp/neurosim-brain.sock")
)
NUM_STEPS = 100
DT_MS = 0.1
DT_SEC = DT_MS / 1000.0


def main() -> int:
    if not SOCKET_PATH.exists():
        print(f"Socket not found: {SOCKET_PATH}", file=sys.stderr)
        print("Start the Rust brain-service first.", file=sys.stderr)
        return 1

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(60.0)
    try:
        sock.connect(str(SOCKET_PATH))
    except OSError as e:
        print(f"Connect failed: {e}", file=sys.stderr)
        return 1
    f = sock.makefile("rwb")
    try:
        try:
            f.write(b'{"method":"create","params":{}}\n')
            f.flush()
            line = f.readline()
            if not line:
                raise RuntimeError("socket closed")
            out = json.loads(line.decode("utf-8"))
            if out.get("error"):
                raise RuntimeError(out["error"])
            sim_id = int(out["sim_id"])

            req = {
                "method": "run_steps",
                "params": {
                    "sim_id": sim_id,
                    "num_steps": NUM_STEPS,
                    "dt": DT_SEC,
                    "stim_rates_by_id": {},
                    "count_neuron_ids": [],
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
        except Exception as e:
            print(f"RPC failed: {e}", file=sys.stderr)
            return 1
    finally:
        f.close()
        sock.close()

    wall_sec = step.get("wall_sec")
    if wall_sec is not None:
        ms_per_step = 1000.0 * wall_sec / NUM_STEPS
        print(f"100 steps @ 0.1 ms dt: wall {wall_sec:.3f} s ({ms_per_step:.2f} ms/step)")
    else:
        print("100 steps @ 0.1 ms dt: (no wall_sec in response)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
