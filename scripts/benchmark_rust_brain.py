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
# Single connectome (same as brain-service); no env override.
CONNECTOME_PATH = ROOT / "data" / "raw" / "2025_Connectivity_783.parquet"
DT_SEC = 0.0001  # 0.1 ms
N_WARMUP = 5
N_STEPS = 100
RUN_STEPS_COUNT = int(os.environ.get("NEUROSIM_BENCHMARK_RUN_STEPS", "5000"))

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
            f"  NEUROSIM_BRAIN_SOCKET={SOCKET_PATH} api/brain-sim-service/target/release/brain-service &",
            file=sys.stderr,
        )
        return 1

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(60.0)

    t_connect = time.perf_counter()
    sock.connect(str(SOCKET_PATH))
    connect_sec = time.perf_counter() - t_connect
    print(f"[timing] connect: {connect_sec:.3f} s")

    f = sock.makefile("rwb")
    try:
        # create
        t_create = time.perf_counter()
        f.write(b'{"method":"create","params":{}}\n')
        f.flush()
        out = json.loads(f.readline().decode("utf-8"))
        create_sec = time.perf_counter() - t_create
        print(f"[timing] create (round-trip): {create_sec:.3f} s")
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
        t_warmup = time.perf_counter()
        for _ in range(N_WARMUP):
            f.write(msg0)
            f.flush()
            f.readline()
        warmup_sec = time.perf_counter() - t_warmup
        print(f"[timing] warmup ({N_WARMUP} steps): {warmup_sec:.3f} s")

        # timed run: 100 steps
        t0 = time.perf_counter()
        for i in range(N_STEPS):
            t_sim = i * DT_SEC
            msg = (json.dumps(step_payload(t_sim)) + "\n").encode("utf-8")
            f.write(msg)
            f.flush()
            f.readline()
        elapsed = time.perf_counter() - t0
        print(f"[timing] {N_STEPS} steps (total): {elapsed:.3f} s")

        # run_steps benchmark (one RPC, with record_ticks; server logs parse/steps_loop/serialize)
        count_ids = []
        csv_path = ROOT / "data" / "forced_epg_r4_l6_neurons.csv"
        if csv_path.exists():
            import csv
            with open(csv_path, newline="") as fp:
                for row in csv.DictReader(fp):
                    if row.get("root_id"):
                        count_ids.append(row["root_id"].strip())
        count_ids = count_ids[:6] if count_ids else []
        run_steps_payload = {
            "method": "run_steps",
            "params": {
                "sim_id": sim_id,
                "num_steps": RUN_STEPS_COUNT,
                "dt": DT_SEC,
                "record_ticks": True,
                "count_neuron_ids": count_ids if count_ids else None,
            },
        }
        t_run_steps = time.perf_counter()
        f.write((json.dumps(run_steps_payload) + "\n").encode("utf-8"))
        f.flush()
        line = f.readline().decode("utf-8")
        if not line:
            raise RuntimeError("socket closed during run_steps benchmark")
        try:
            run_steps_out = json.loads(line)
        except Exception as e:
            raise RuntimeError(f"invalid run_steps response JSON: {e}") from e
        if isinstance(run_steps_out, dict) and run_steps_out.get("error"):
            raise RuntimeError(f"run_steps error: {run_steps_out['error']}")
        if not isinstance(run_steps_out, dict) or "steps_done" not in run_steps_out:
            raise RuntimeError(f"unexpected run_steps response: {run_steps_out!r}")
        run_steps_sec = time.perf_counter() - t_run_steps
        print(f"[timing] run_steps({RUN_STEPS_COUNT} steps, record_ticks=True): {run_steps_sec:.3f} s (see server stderr for parse/steps_loop/serialize)")

        # Rust service has no "reset"; just close
    finally:
        f.close()
        sock.close()

    ms_per_step = (elapsed / N_STEPS) * 1000
    print()
    print(f"Rust brain-service: {N_STEPS} steps @ dt=0.1 ms (0.0001 s)")
    print(f"  Total steps: {elapsed:.3f} s")
    print(f"  Per step: {ms_per_step:.2f} ms")
    print(f"  1 s sim (10k steps) at this rate: {(10000 * ms_per_step) / 1000:.1f} s wall")
    return 0


if __name__ == "__main__":
    sys.exit(main())
