#!/usr/bin/env python3
"""Benchmark Rust brain-service: 100 steps at 0.1 ms (dt=0.0001 s)."""
from __future__ import annotations

import json
import os
import socket
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Use a dedicated socket so we don't clash with python-brain
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET_RUST", "/tmp/neurosim-rust-bench.sock"))
CONNECTOME_PATH = os.environ.get("NEUROSIM_CONNECTOME_PATH", str(ROOT / "data" / "raw" / "2025_Connectivity_783.parquet"))
DT_SEC = 0.0001  # 0.1 ms
N_WARMUP = 5
N_STEPS = 100

# Rust step expects: sim_id, dt, include_activity, fly, sources
DEFAULT_FLY = {
    "x": 0.0,
    "y": 0.0,
    "z": 0.35,
    "heading": 0.0,
    "t": 0.0,
    "hunger": 40.0,
    "health": 100.0,
    "rest_time_left": 0.0,
    "dead": False,
}


def main() -> int:
    if not SOCKET_PATH.exists():
        print(
            f"Socket not found: {SOCKET_PATH}",
            file=sys.stderr,
        )
        print(
            "Start the Rust brain-service first, e.g.:",
            file=sys.stderr,
        )
        print(
            f"  NEUROSIM_BRAIN_SOCKET={SOCKET_PATH} NEUROSIM_CONNECTOME_PATH={CONNECTOME_PATH} "
            "api/brain-sim-service/target/release/brain-service &",
            file=sys.stderr,
        )
        return 1

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(60.0)
    sock.connect(str(SOCKET_PATH))
    f = sock.makefile("rwb")
    try:
        # create
        f.write(b'{"method":"create","params":{}}\n')
        f.flush()
        out = json.loads(f.readline().decode("utf-8"))
        if out.get("error"):
            print("Error (create):", out["error"], file=sys.stderr)
            return 1
        sim_id = out["sim_id"]

        def step_payload(t: float):
            return {
                "method": "step",
                "params": {
                    "sim_id": sim_id,
                    "dt": DT_SEC,
                    "include_activity": False,
                    "fly": {**DEFAULT_FLY, "t": t},
                    "sources": [],
                },
            }

        msg0 = (json.dumps(step_payload(0.0)) + "\n").encode("utf-8")

        # warmup
        for i in range(N_WARMUP):
            f.write(msg0)
            f.flush()
            f.readline()

        # timed run: 100 steps
        t0 = time.perf_counter()
        for i in range(N_STEPS):
            t_sim = i * DT_SEC
            msg = (json.dumps(step_payload(t_sim)) + "\n").encode("utf-8")
            f.write(msg)
            f.flush()
            f.readline()
        elapsed = time.perf_counter() - t0

        # Rust service has no "reset"; just close
    finally:
        f.close()
        sock.close()

    ms_per_step = (elapsed / N_STEPS) * 1000
    print(f"Rust brain-service: {N_STEPS} steps @ dt=0.1 ms (0.0001 s)")
    print(f"  Total: {elapsed:.3f} s")
    print(f"  Per step: {ms_per_step:.2f} ms")
    print(f"  1 s sim (10k steps) at this rate: {(10000 * ms_per_step) / 1000:.1f} s wall")
    return 0


if __name__ == "__main__":
    sys.exit(main())
