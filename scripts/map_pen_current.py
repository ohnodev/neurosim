#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import math
import os
from pathlib import Path
from rpc import Rpc

ROOT = Path(__file__).resolve().parents[1]
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", "/tmp/neurosim-brain.sock"))

TICKS = int(os.environ.get("NEUROSIM_MAP_TICKS", "4000"))
DT_MS = float(os.environ.get("NEUROSIM_MAP_DT_MS", "1.0"))
INIT_TICKS = int(os.environ.get("NEUROSIM_MAP_INIT_TICKS", "800"))
PEN_DIRECTION = os.environ.get("NEUROSIM_MAP_PEN_DIRECTION", "cw").strip().lower()
PEN_BASE_CURRENT = float(os.environ.get("NEUROSIM_MAP_PEN_BASE_CURRENT", "20.0"))
PEN_BIAS_MIN = float(os.environ.get("NEUROSIM_MAP_PEN_BIAS_MIN", "1.0"))
PEN_BIAS_MAX = float(os.environ.get("NEUROSIM_MAP_PEN_BIAS_MAX", "40.0"))
PEN_BIAS_STEP = float(os.environ.get("NEUROSIM_MAP_PEN_BIAS_STEP", "1.0"))
GLOBAL_BASE_CURRENT = float(os.environ.get("NEUROSIM_MAP_GLOBAL_BASE_CURRENT", "0.0"))
INIT_BUMP_TICKS = int(os.environ.get("NEUROSIM_MAP_INIT_BUMP_TICKS", "12"))
INIT_BUMP_CURRENT = float(os.environ.get("NEUROSIM_MAP_INIT_BUMP_CURRENT", "35.0"))


EPG_SLICE_ORDER_CLOCKWISE = [
    "L5", "R4", "L6", "R3", "L7", "R2", "L8", "R1",
    "L1", "R8", "L2", "R7", "L3", "R6", "L4", "R5",
]
EPG_LABEL_TO_ANGLE = {
    label: (2.0 * math.pi * i / len(EPG_SLICE_ORDER_CLOCKWISE))
    for i, label in enumerate(EPG_SLICE_ORDER_CLOCKWISE)
}


def _frange(start: float, stop: float, step: float) -> list[float]:
    vals = []
    x = start
    while x <= stop + 1e-9:
        vals.append(round(x, 6))
        x += step
    return vals


def _heading_from_spikes(epg_spike_ids: list[str], epg_label_map: dict[str, str]) -> float | None:
    angles = []
    for rid in epg_spike_ids:
        lbl = epg_label_map.get(rid)
        if not lbl:
            continue
        a = EPG_LABEL_TO_ANGLE.get(lbl)
        if a is not None:
            angles.append(a)
    if not angles:
        return None
    cx = sum(math.cos(a) for a in angles) / len(angles)
    cy = sum(math.sin(a) for a in angles) / len(angles)
    h = math.atan2(cy, cx)
    if h < 0:
        h += 2.0 * math.pi
    return h


def _unwrap_angles(xs: list[float]) -> list[float]:
    if not xs:
        return []
    out = [xs[0]]
    for a in xs[1:]:
        prev = out[-1]
        d = (a - (prev % (2.0 * math.pi)) + math.pi) % (2.0 * math.pi) - math.pi
        out.append(prev + d)
    return out


def _pick_seed_epg_ids(epg_label_map: dict[str, str]) -> list[str]:
    label_to_ids: dict[str, list[str]] = {}
    for rid, lbl in epg_label_map.items():
        label_to_ids.setdefault(lbl, []).append(rid)
    # Choose two labels ~180deg apart to initialize a weak bump seed.
    labels = [lbl for lbl in EPG_SLICE_ORDER_CLOCKWISE if lbl in label_to_ids]
    if not labels:
        return []
    a = labels[0]
    b = labels[len(labels) // 2]
    return [label_to_ids[a][0], label_to_ids[b][0]]


def main() -> int:
    if PEN_DIRECTION not in {"cw", "ccw"}:
        raise ValueError("NEUROSIM_MAP_PEN_DIRECTION must be cw or ccw")
    if PEN_BIAS_STEP <= 0:
        raise ValueError("NEUROSIM_MAP_PEN_BIAS_STEP must be positive")
    if INIT_TICKS >= TICKS:
        raise ValueError("NEUROSIM_MAP_INIT_TICKS must be less than TICKS")

    class_map: dict[str, dict[str, str]] = {}
    with (ROOT / "data" / "raw" / "classification.csv").open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = row.get("root_id", "")
            if rid:
                class_map[rid] = row

    epg_entries = json.loads((ROOT / "data" / "epg-tile-map.json").read_text(encoding="utf-8"))["entries"]
    epg_set = {str(e["root_id"]) for e in epg_entries}
    epg_label_map: dict[str, str] = {}
    for e in epg_entries:
        rid = str(e.get("root_id"))
        side = str(class_map.get(rid, {}).get("side", e.get("side", ""))).strip().lower()
        bin_0_7 = e.get("tile_index_0_7")
        if isinstance(bin_0_7, int):
            n = bin_0_7 + 1
            if 1 <= n <= 8:
                prefix = "L" if side == "left" else ("R" if side == "right" else "")
                if prefix:
                    epg_label_map[rid] = f"{prefix}{n}"

    pen_left_ids = sorted(
        {
            rid
            for rid, row in class_map.items()
            if "PEN" in (row.get("hemibrain_type") or "")
            and (row.get("side") or "").strip().lower() == "left"
        }
    )
    pen_right_ids = sorted(
        {
            rid
            for rid, row in class_map.items()
            if "PEN" in (row.get("hemibrain_type") or "")
            and (row.get("side") or "").strip().lower() == "right"
        }
    )
    left_sign = 1.0 if PEN_DIRECTION == "cw" else -1.0
    right_sign = -1.0 if PEN_DIRECTION == "cw" else 1.0
    seed_epg_ids = _pick_seed_epg_ids(epg_label_map)

    results = []
    rpc = Rpc(SOCKET_PATH)
    try:
        rpc.request("ping")
        for pen_bias in _frange(PEN_BIAS_MIN, PEN_BIAS_MAX, PEN_BIAS_STEP):
            sim_id = int(rpc.request("create")["sim_id"])
            headings: list[float] = []
            heading_ticks: list[int] = []
            epg_events = 0
            try:
                for tick in range(1, TICKS + 1):
                    ext: dict[str, float] = {}
                    for rid in pen_left_ids:
                        ext[rid] = PEN_BASE_CURRENT + (left_sign * pen_bias)
                    for rid in pen_right_ids:
                        ext[rid] = PEN_BASE_CURRENT + (right_sign * pen_bias)
                    if tick <= INIT_BUMP_TICKS:
                        for rid in seed_epg_ids:
                            ext[rid] = ext.get(rid, 0.0) + INIT_BUMP_CURRENT
                    step = rpc.request("step", {
                        "sim_id": sim_id,
                        "dt_ms": DT_MS,
                        "external_current_by_id": ext,
                        "global_external_current": GLOBAL_BASE_CURRENT,
                    })
                    ids = [str(x) for x in step.get("spike_ids_step", [])]
                    epg_ids = [rid for rid in ids if rid in epg_set]
                    epg_events += len(epg_ids)
                    if tick > INIT_TICKS:
                        h = _heading_from_spikes(epg_ids, epg_label_map)
                        if h is not None:
                            headings.append(h)
                            heading_ticks.append(tick)
                unwrapped = _unwrap_angles(headings)
                if len(unwrapped) >= 2:
                    delta_rad = unwrapped[-1] - unwrapped[0]
                    first_tick = heading_ticks[0]
                    last_tick = heading_ticks[-1]
                    seconds = ((last_tick - first_tick) * DT_MS) / 1000.0
                    deg_per_sec = (math.degrees(delta_rad) / seconds) if seconds > 0 else 0.0
                else:
                    deg_per_sec = 0.0
                results.append({
                    "pen_bias_current": pen_bias,
                    "pen_base_current": PEN_BASE_CURRENT,
                    "direction": PEN_DIRECTION,
                    "epg_spike_events": epg_events,
                    "sample_count": len(unwrapped),
                    "angular_velocity_deg_per_sec": deg_per_sec,
                })
            finally:
                # Service currently does not expose delete(sim_id); keep sims bounded with reset.
                try:
                    rpc.request("reset", {})
                except Exception as e:
                    print(f"warning: reset failed for pen_bias={pen_bias}: {e}")
    finally:
        rpc.close()

    out_dir = ROOT / "logs"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_json = out_dir / "map_pen_current_results.json"
    out_csv = out_dir / "map_pen_current_results.csv"
    out_json.write_text(json.dumps({
        "params": {
            "ticks": TICKS,
            "dt_ms": DT_MS,
            "init_ticks": INIT_TICKS,
            "pen_base_current": PEN_BASE_CURRENT,
            "pen_bias_min": PEN_BIAS_MIN,
            "pen_bias_max": PEN_BIAS_MAX,
            "pen_bias_step": PEN_BIAS_STEP,
            "pen_direction": PEN_DIRECTION,
            "global_base_current": GLOBAL_BASE_CURRENT,
            "init_bump_ticks": INIT_BUMP_TICKS,
            "init_bump_current": INIT_BUMP_CURRENT,
        },
        "results": results,
    }, indent=2), encoding="utf-8")

    with out_csv.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            "pen_bias_current",
            "pen_base_current",
            "direction",
            "epg_spike_events",
            "sample_count",
            "angular_velocity_deg_per_sec",
        ])
        for r in results:
            w.writerow([
                r["pen_bias_current"],
                r["pen_base_current"],
                r["direction"],
                r["epg_spike_events"],
                r["sample_count"],
                r["angular_velocity_deg_per_sec"],
            ])

    best = max(results, key=lambda r: abs(float(r["angular_velocity_deg_per_sec"])), default=None)
    print(json.dumps({
        "outputs": {"json": str(out_json), "csv": str(out_csv)},
        "best_by_abs_deg_per_sec": best,
        "count": len(results),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
