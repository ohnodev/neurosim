#!/usr/bin/env python3
"""
Run 4000 ticks at 0.1 ms dt: PEN 40 Hz for ticks 1–3000, then left PEN 60% / right 40%
(48 Hz left, 32 Hz right) for ticks 3001–4000 to test if the bump starts rotating.
Export replay to world/public for frontend.

Usage:
  python3 scripts/run_pen40hz_4k_leftbump_export.py

Requires python-brain socket running.
"""
from __future__ import annotations

import csv
import json
import os
import socket
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", "/tmp/neurosim-brain.sock"))
SOCKET_TIMEOUT = 600.0  # seconds; run_steps can take several minutes

DT_MS = 0.1
DT_SEC = DT_MS / 1000.0
TICKS_BASELINE = 3000
TICKS_BUMP = 1000
NUM_STEPS_TOTAL = TICKS_BASELINE + TICKS_BUMP  # 4000
PEN_HZ_BASELINE = 40.0
# After 3k ticks: 60% left, 40% right
LEFT_HZ_BUMP = 48.0   # 60% of (48+32)=80
RIGHT_HZ_BUMP = 32.0  # 40%


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
    replay_filename = "neurosim_pen40hz_4k_leftbump_replay.json"
    out_replay = ROOT / "world" / "public" / replay_filename
    scenario = "neurosim_pen40hz_4k_leftbump"

    epg_path = ROOT / "data" / "epg-tile-map.json"
    class_path = ROOT / "data" / "raw" / "classification.csv"
    if not epg_path.exists():
        print(f"Missing {epg_path}", flush=True)
        return 1
    if not class_path.exists():
        print(f"Missing {class_path}", flush=True)
        return 1

    pen_ids = load_pen_ids(class_path)
    epg_entries, class_map = load_epg_and_class(epg_path, class_path)
    epg_ids = [str(e["root_id"]) for e in epg_entries]

    left_pen = [rid for rid in pen_ids if class_map.get(rid, {}).get("side", "").strip().lower() == "left"]
    right_pen = [rid for rid in pen_ids if class_map.get(rid, {}).get("side", "").strip().lower() == "right"]
    print(f"PEN: {len(pen_ids)} total, left={len(left_pen)} right={len(right_pen)}", flush=True)
    print(f"EPG: {len(epg_ids)} neurons", flush=True)
    print(f"Run: {TICKS_BASELINE} ticks @ 40 Hz, then {TICKS_BUMP} ticks @ left={LEFT_HZ_BUMP} right={RIGHT_HZ_BUMP} Hz", flush=True)
    print(f"Out: {out_replay}", flush=True)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(SOCKET_TIMEOUT)
    sock.connect(str(SOCKET_PATH))
    f = sock.makefile("rwb")
    try:
        def read_response() -> bytes:
            try:
                line = f.readline()
            except socket.timeout:
                print("Brain service socket timeout; is the service running?", flush=True)
                raise
            if not line:
                raise RuntimeError("socket closed")
            return line

        f.write(b'{"method":"create","params":{}}\n')
        f.flush()
        out = json.loads(read_response().decode("utf-8"))
        if out.get("error"):
            raise RuntimeError(out["error"])
        sim_id = int(out["sim_id"])

        # Phase 1: 3000 ticks at 40 Hz all PEN
        stim_baseline = {rid: PEN_HZ_BASELINE for rid in pen_ids}
        req1 = {
            "method": "run_steps",
            "params": {
                "sim_id": sim_id,
                "num_steps": TICKS_BASELINE,
                "dt": DT_SEC,
                "stim_rates_by_id": stim_baseline,
                "count_neuron_ids": epg_ids,
                "record_ticks": True,
            },
        }
        f.write((json.dumps(req1) + "\n").encode("utf-8"))
        f.flush()
        resp1 = json.loads(read_response().decode("utf-8"))
        if resp1.get("error"):
            raise RuntimeError(resp1["error"])
        ticks_a = resp1.get("ticks") or []

        # Phase 2: 1000 ticks with left 48 Hz, right 32 Hz (60/40)
        stim_bump = {rid: LEFT_HZ_BUMP for rid in left_pen}
        for rid in right_pen:
            stim_bump[rid] = RIGHT_HZ_BUMP
        req2 = {
            "method": "run_steps",
            "params": {
                "sim_id": sim_id,
                "num_steps": TICKS_BUMP,
                "dt": DT_SEC,
                "stim_rates_by_id": stim_bump,
                "count_neuron_ids": epg_ids,
                "record_ticks": True,
            },
        }
        f.write((json.dumps(req2) + "\n").encode("utf-8"))
        f.flush()
        resp2 = json.loads(read_response().decode("utf-8"))
        if resp2.get("error"):
            raise RuntimeError(resp2["error"])
        ticks_b = resp2.get("ticks") or []

        f.write(b'{"method":"reset","params":{}}\n')
        f.flush()
        read_response()
    finally:
        f.close()
        sock.close()

    # Renumber phase-2 ticks to 3001..4000 and merge
    for t in ticks_b:
        t["tick"] = TICKS_BASELINE + t["tick"]
        t["time_sec"] = round(t["tick"] * DT_SEC, 6)
    ticks_merged = ticks_a + ticks_b

    spike_counts_1 = resp1.get("spike_counts") or {}
    spike_counts_2 = resp2.get("spike_counts") or {}
    epg_total_1 = sum(int(spike_counts_1.get(rid, 0)) for rid in epg_ids)
    epg_total_2 = sum(int(spike_counts_2.get(rid, 0)) for rid in epg_ids)
    epg_unique_1 = sum(1 for rid in epg_ids if int(spike_counts_1.get(rid, 0)) > 0)
    epg_unique_2 = sum(1 for rid in epg_ids if int(spike_counts_2.get(rid, 0)) > 0)
    wall_sec = (resp1.get("wall_sec") or 0) + (resp2.get("wall_sec") or 0)

    print(f"Wall: {wall_sec:.1f} s", flush=True)
    print(f"EPG phase1 events: {epg_total_1} unique: {epg_unique_1}", flush=True)
    print(f"EPG phase2 events: {epg_total_2} unique: {epg_unique_2}", flush=True)

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
            "ticks": len(ticks_merged),
            "dt_sec": DT_SEC,
            "scenario": scenario,
            "epg_neuron_total": len(epg_ids),
            "epg_neuron_unique_fired": max(epg_unique_1, epg_unique_2),
            "stimulus": {
                "pen_hz_baseline": PEN_HZ_BASELINE,
                "ticks_baseline": TICKS_BASELINE,
                "left_hz_bump": LEFT_HZ_BUMP,
                "right_hz_bump": RIGHT_HZ_BUMP,
                "ticks_bump": TICKS_BUMP,
                "pen_pool_size": len(pen_ids),
                "dt_ms": DT_MS,
            },
            "observed": {
                "epg_spike_events_phase1": epg_total_1,
                "epg_spike_events_phase2": epg_total_2,
            },
        },
        "neurons": replay_neurons,
        "ticks": ticks_merged,
    }
    out_replay.parent.mkdir(parents=True, exist_ok=True)
    out_replay.write_text(json.dumps(replay) + "\n", encoding="utf-8")
    print(f"Wrote {out_replay}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
