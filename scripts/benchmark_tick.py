#!/usr/bin/env python3
"""Measure time per tick (step) for python-brain: socket RTT + server compute."""
from __future__ import annotations

import json
import socket
import time
from pathlib import Path

import os
from pathlib import Path

SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", "/tmp/neurosim-brain.sock"))

DT_SEC = 0.0001  # 0.1 ms
N_WARMUP = 5
N_STEPS = int(os.environ.get("NEUROSIM_BENCHMARK_STEPS", "100"))


def main() -> None:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(str(SOCKET_PATH))
    f = sock.makefile("rwb")
    try:
        # create
        f.write(b'{"method":"create","params":{}}\n')
        f.flush()
        out = json.loads(f.readline().decode("utf-8"))
        if out.get("error"):
            print("Error:", out["error"])
            return
        sim_id = out["sim_id"]
        payload = {
            "method": "step",
            "params": {"sim_id": sim_id, "dt": DT_SEC, "include_activity": False},
        }
        msg = (json.dumps(payload) + "\n").encode("utf-8")

        # warmup
        for _ in range(N_WARMUP):
            f.write(msg)
            f.flush()
            f.readline()

        # timed run
        t0 = time.perf_counter()
        for _ in range(N_STEPS):
            f.write(msg)
            f.flush()
            f.readline()
        elapsed = time.perf_counter() - t0

        f.write(b'{"method":"reset","params":{}}\n')
        f.flush()
        f.readline()
    finally:
        f.close()
        sock.close()

    ms_per_step = (elapsed / N_STEPS) * 1000
    print(f"Steps: {N_STEPS} (dt=0.1 ms each, 1 step per RPC)")
    print(f"Total: {elapsed:.3f} s")
    print(f"Per step: {ms_per_step:.2f} ms")
    print(f"1 s sim (10k steps) at this rate: {(10000 * ms_per_step) / 1000:.1f} s wall")
    print()
    print("Bottleneck: each step does (1, 127k) @ (127k, 127k) sparse matmul on CPU → ~25–30 ms.")
    print("Use run_steps (one RPC for many steps) to avoid 10k round-trips; calibration uses it.")
    print("For faster runs: NEUROSIM_PYTHON_BRAIN_DEVICE=cuda if GPU available.")


if __name__ == "__main__":
    main()
