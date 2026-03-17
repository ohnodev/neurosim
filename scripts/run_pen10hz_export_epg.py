#!/usr/bin/env python3
"""
Run 1 s at 0.1 ms dt (10_000 steps): PEN at given Hz Poisson, everything else 0 Hz.
Export replay with EPG spike counts to world/public for frontend inspection.

Usage:
  python3 scripts/run_pen10hz_export_epg.py [PEN_HZ]
  python3 scripts/run_pen10hz_export_epg.py 10   # default
  python3 scripts/run_pen10hz_export_epg.py 20
  python3 scripts/run_pen10hz_export_epg.py 40
"""
from __future__ import annotations

import csv
import json
import math
import os
import socket
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _default_brain_socket_path() -> str:
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        return str(Path(xdg) / "neurosim" / "neurosim-brain.sock")
    return "/tmp/neurosim/neurosim-brain.sock"


SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", _default_brain_socket_path()))

DT_MS = 0.1
DT_SEC = DT_MS / 1000.0
DURATION_MS = 1000.0
NUM_STEPS = round(DURATION_MS / DT_MS)  # 10_000


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
    pen_hz = 10.0
    if len(sys.argv) > 1:
        try:
            pen_hz = float(sys.argv[1])
        except ValueError:
            print("Usage: run_pen10hz_export_epg.py [PEN_HZ]", file=sys.stderr)
            return 1
    if not math.isfinite(pen_hz) or pen_hz <= 0:
        print("PEN_HZ must be finite and positive (got non-finite or <= 0)", file=sys.stderr)
        return 1

    pen_hz_str = str(pen_hz).replace(".", "p")
    replay_filename = f"neurosim_pen{pen_hz_str}hz_1s_replay.json"
    out_replay = ROOT / "world" / "public" / replay_filename
    scenario = f"neurosim_pen{pen_hz_str}hz_1s"

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

    if not pen_ids:
        print(f"PEN set is empty; class_path={class_path}", file=sys.stderr)
        return 1
    if not epg_ids:
        print(f"EPG set is empty; epg_path={epg_path}", file=sys.stderr)
        return 1

    print(f"PEN: {len(pen_ids)} neurons at {pen_hz} Hz", flush=True)
    print(f"EPG: {len(epg_ids)} neurons, counting spikes", flush=True)
    print(f"Run: {NUM_STEPS} steps, dt={DT_MS} ms, {DURATION_MS} ms total", flush=True)
    print(f"Out: {out_replay}", flush=True)

    if not SOCKET_PATH.exists():
        print(f"Socket path does not exist: {SOCKET_PATH}", file=sys.stderr)
        return 1
    if not stat.S_ISSOCK(SOCKET_PATH.stat().st_mode):
        print(f"Path is not a Unix domain socket: {SOCKET_PATH}", file=sys.stderr)
        return 1

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(30.0)
    try:
        sock.connect(str(SOCKET_PATH))
    except (socket.timeout, OSError) as e:
        print(f"Connect failed: {e}", file=sys.stderr)
        sock.close()
        return 1
    try:
        f = sock.makefile("rwb")
    except (socket.timeout, OSError) as e:
        print(f"makefile failed: {e}", file=sys.stderr)
        sock.close()
        return 1
    try:
        f.write(b'{"method":"create","params":{}}\n')
        f.flush()
        out = json.loads(f.readline().decode("utf-8"))
        if out.get("error"):
            raise RuntimeError(out["error"])
        sim_id = int(out["sim_id"])

        stim_rates = {rid: pen_hz for rid in pen_ids}
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

        f.write(b'{"method":"reset","params":{}}\n')
        f.flush()
        f.readline()
    except (socket.timeout, OSError, RuntimeError) as e:
        print(f"Socket or runtime error: {e}", file=sys.stderr)
        raise
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
                "pen_hz": pen_hz,
                "pen_pool_size": len(pen_ids),
                "duration_ms": DURATION_MS,
                "dt_ms": DT_MS,
            },
            "observed": {
                "epg_spike_events_total": epg_total,
                "epg_unique_fired_total": epg_unique,
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
