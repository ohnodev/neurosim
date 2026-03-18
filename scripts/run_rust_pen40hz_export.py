#!/usr/bin/env python3
"""
Run 10k ticks at 0.1 ms dt: PEN at 40 Hz on each side (Poisson via Rust run_steps).
Export replay to world/public for frontend. Uses Rust brain-service socket.

Usage:
  # Start Rust service first (loads full parquet by default):
  #   api/brain-sim-service/target/release/brain-service &
  python3 scripts/run_rust_pen40hz_export.py
"""
from __future__ import annotations

import csv
import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOCKET_PATH = Path(
    os.environ.get("NEUROSIM_BRAIN_SOCKET_RUST", "/tmp/neurosim-rust-bench.sock")
)

DT_MS = 0.1
DT_SEC = DT_MS / 1000.0
DURATION_MS = 1000.0
NUM_STEPS = round(DURATION_MS / DT_MS)  # 10_000
PEN_HZ = 40.0


def load_pen_ids(class_map_path: Path) -> list[str]:
    pen = []
    with class_map_path.open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = (row.get("root_id") or "").strip()
            if rid and "PEN" in (row.get("hemibrain_type") or ""):
                pen.append(rid)
    return sorted(set(pen))


def load_epg_and_class(epg_path: Path, class_map_path: Path) -> tuple[list[dict], dict[str, dict]]:
    epg_data = json.loads(epg_path.read_text(encoding="utf-8"))
    entries = epg_data.get("entries", epg_data if isinstance(epg_data, list) else [])
    class_map: dict[str, dict[str, str]] = {}
    with class_map_path.open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = (row.get("root_id") or "").strip()
            if rid:
                class_map[rid] = row
    return entries, class_map


def main() -> int:
    recurrence_boost = os.environ.get("NEUROSIM_EPG_RECURRENCE_BOOST", "").strip()
    rec_suffix = ""
    rec_boost_meta: float | None = None
    if recurrence_boost:
        try:
            rec_boost_meta = float(recurrence_boost)
            if rec_boost_meta.is_integer():
                rec_suffix = f"_epgrec{int(rec_boost_meta)}x"
            else:
                rec_suffix = f"_epgrec{str(rec_boost_meta).replace('.', 'p')}x"
        except ValueError:
            rec_suffix = f"_epgrec{recurrence_boost.replace('.', 'p')}x"

    replay_filename = f"neurosim_rust_pen40hz_1s{rec_suffix}_replay.json"
    out_replay = ROOT / "world" / "public" / replay_filename
    scenario = f"neurosim_rust_pen40hz_1s{rec_suffix}"

    epg_path = ROOT / "data" / "epg-tile-map.json"
    class_path = ROOT / "data" / "raw" / "classification.csv"
    if not epg_path.exists():
        print(f"Missing {epg_path}", flush=True)
        return 1
    if not class_path.exists():
        print(f"Missing {class_path}", flush=True)
        return 1
    if not SOCKET_PATH.exists():
        print(f"Socket not found: {SOCKET_PATH}", flush=True)
        print("Start the Rust brain-service first (see script docstring).", flush=True)
        return 1

    pen_ids = load_pen_ids(class_path)
    epg_entries, class_map = load_epg_and_class(epg_path, class_path)
    epg_ids = [str(e["root_id"]) for e in epg_entries]

    stim_rates = {rid: PEN_HZ for rid in pen_ids}
    print(f"PEN: {len(pen_ids)} neurons at {PEN_HZ} Hz", flush=True)
    print(f"EPG: {len(epg_ids)} neurons, counting spikes", flush=True)
    if rec_boost_meta is not None:
        print(f"EPG recurrence boost: {rec_boost_meta}x", flush=True)
    print(f"Run: {NUM_STEPS} steps, dt={DT_MS} ms, Rust socket {SOCKET_PATH}", flush=True)
    print(f"Out: {out_replay}", flush=True)

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
                "num_steps": NUM_STEPS,
                "dt": DT_SEC,
                "stim_rates_by_id": stim_rates,
                "count_neuron_ids": epg_ids,
                "record_ticks": True,
            },
        }
        f.write((json.dumps(req) + "\n").encode("utf-8"))
        f.flush()
        line = f.readline()
        if not line:
            raise RuntimeError("socket closed")
        resp = json.loads(line.decode("utf-8"))
        if resp.get("error"):
            raise RuntimeError(resp["error"])
    finally:
        f.close()
        sock.close()

    spike_counts = resp.get("spike_counts") or {}
    epg_total = sum(int(spike_counts.get(rid, 0)) for rid in epg_ids)
    epg_unique = sum(1 for rid in epg_ids if int(spike_counts.get(rid, 0)) > 0)
    ticks = resp.get("ticks") or []
    wall_sec = resp.get("wall_sec", 0)

    print(f"Wall: {wall_sec:.1f} s", flush=True)
    print(f"EPG spike events: {epg_total}", flush=True)
    print(f"EPG unique fired: {epg_unique}", flush=True)

    replay_neurons = []
    for e in epg_entries:
        rid = str(e.get("root_id", ""))
        c = class_map.get(rid, {})
        replay_neurons.append({
            "root_id": rid,
            "x": 0,
            "y": 0,
            "z": 0,
            "processed_label": c.get("cell_type", ""),
            "is_ring": True,
            "is_epg": True,
            "epg_tile_index_0_7": e.get("tile_index_0_7"),
            "side": c.get("side", e.get("side", "unknown")),
            "hemibrain_type": c.get("hemibrain_type", e.get("hemibrain_type", "")),
            "flow": c.get("flow", ""),
            "super_class": c.get("super_class", ""),
            "class": c.get("class", ""),
            "sub_class": c.get("sub_class", ""),
            "cell_type": c.get("cell_type", ""),
            "hemilineage": c.get("hemilineage", ""),
            "nerve": c.get("nerve", ""),
        })

    replay = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "ticks": len(ticks),
            "dt_sec": DT_SEC,
            "scenario": scenario,
            "epg_neuron_total": len(epg_ids),
            "epg_neuron_unique_fired": epg_unique,
            "stimulus": {
                "pen_hz": PEN_HZ,
                "pen_pool_size": len(pen_ids),
                "duration_ms": DURATION_MS,
                "dt_ms": DT_MS,
                "backend": "rust",
                "epg_recurrence_boost": rec_boost_meta,
            },
            "observed": {
                "epg_spike_events_total": epg_total,
                "epg_unique_fired_total": epg_unique,
                "wall_sec": wall_sec,
            },
        },
        "neurons": replay_neurons,
        "ticks": ticks,
    }
    out_replay.parent.mkdir(parents=True, exist_ok=True)
    out_replay.write_text(json.dumps(replay) + "\n", encoding="utf-8")
    print(f"Wrote {out_replay}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
