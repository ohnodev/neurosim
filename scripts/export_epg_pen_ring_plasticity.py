#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from rpc import Rpc

ROOT = Path(__file__).resolve().parents[1]
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", "/tmp/neurosim-brain.sock"))

TICKS = int(os.environ.get("NEUROSIM_EXPORT_TICKS", "2000"))
LEARN_TICKS = int(os.environ.get("NEUROSIM_EXPORT_LEARN_TICKS", "1000"))
DT_MS = float(os.environ.get("NEUROSIM_EXPORT_DT_MS", "1.0"))
DT_SEC = DT_MS / 1000.0

PEN_BASE_CURRENT = float(os.environ.get("NEUROSIM_EXPORT_PEN_BASE_CURRENT", "20.0"))
PEN_BIAS_CURRENT = float(os.environ.get("NEUROSIM_EXPORT_PEN_BIAS_CURRENT", "5.0"))
PEN_DIRECTION = os.environ.get("NEUROSIM_EXPORT_PEN_DIRECTION", "cw").strip().lower()
PEN_PROBE_SCALE = float(os.environ.get("NEUROSIM_EXPORT_PEN_PROBE_SCALE", "0.0"))

RING_CURRENT = float(os.environ.get("NEUROSIM_EXPORT_RING_CURRENT", "8.0"))
RING_RF_SIGMA_DEG = float(os.environ.get("NEUROSIM_EXPORT_RING_RF_SIGMA_DEG", "18.0"))
RING_VISUAL_GAIN = float(os.environ.get("NEUROSIM_EXPORT_RING_VISUAL_GAIN", "1.0"))
RING_SCALE = float(os.environ.get("NEUROSIM_EXPORT_RING_SCALE", "0.35"))
RING_BASE_CURRENT = float(os.environ.get("NEUROSIM_EXPORT_RING_BASE_CURRENT", "0.0"))
VISUAL_DEG_PER_TICK = float(os.environ.get("NEUROSIM_EXPORT_VISUAL_DEG_PER_TICK", "0.06"))
VISUAL_CONTRAST = float(os.environ.get("NEUROSIM_EXPORT_VISUAL_CONTRAST", "1.0"))
VISUAL_FOV_DEG = float(os.environ.get("NEUROSIM_EXPORT_VISUAL_FOV_DEG", "360.0"))
GLOBAL_BASE_CURRENT = float(os.environ.get("NEUROSIM_EXPORT_GLOBAL_BASE_CURRENT", "0.0"))
VISUAL_MODE = os.environ.get("NEUROSIM_EXPORT_VISUAL_MODE", "bar").strip().lower()
BAR_WIDTH_DEG = float(os.environ.get("NEUROSIM_EXPORT_BAR_WIDTH_DEG", "15.0"))

PLASTIC_GAIN = float(os.environ.get("NEUROSIM_EXPORT_PLASTIC_GAIN", "1.0"))
PLASTIC_ETA = float(os.environ.get("NEUROSIM_EXPORT_PLASTIC_ETA", "0.01"))
PLASTIC_W_MIN = float(os.environ.get("NEUROSIM_EXPORT_PLASTIC_W_MIN", "-0.3"))
PLASTIC_W_MAX = float(os.environ.get("NEUROSIM_EXPORT_PLASTIC_W_MAX", "0.0"))
PLASTIC_INIT_MIN = float(os.environ.get("NEUROSIM_EXPORT_PLASTIC_INIT_MIN", "-0.05"))
PLASTIC_INIT_MAX = float(os.environ.get("NEUROSIM_EXPORT_PLASTIC_INIT_MAX", "-0.05"))


def _tag(x: float) -> str:
    return f"{x:g}".replace(".", "p")


SCENARIO_ID = (
    f"neurosim_epg_penring_plastic_{TICKS}ticks_learn{LEARN_TICKS}_"
    f"{PEN_DIRECTION}_penbase{_tag(PEN_BASE_CURRENT)}_penbias{_tag(PEN_BIAS_CURRENT)}_"
    f"rfscene_{VISUAL_MODE}_ringbase{_tag(RING_BASE_CURRENT)}_ringgain{_tag(RING_VISUAL_GAIN)}_"
    f"rfsig{_tag(RING_RF_SIGMA_DEG)}_vdeg{_tag(VISUAL_DEG_PER_TICK)}_"
    f"gbase{_tag(GLOBAL_BASE_CURRENT)}_probe{_tag(PEN_PROBE_SCALE)}"
)


EPG_SLICE_ORDER_CLOCKWISE = [
    "L5", "R4", "L6", "R3", "L7", "R2", "L8", "R1",
    "L1", "R8", "L2", "R7", "L3", "R6", "L4", "R5",
]
EPG_LABEL_TO_ANGLE = {
    label: (2.0 * math.pi * i / len(EPG_SLICE_ORDER_CLOCKWISE))
    for i, label in enumerate(EPG_SLICE_ORDER_CLOCKWISE)
}


def _wrap_deg(x: float) -> float:
    y = x % 360.0
    if y < 0:
        y += 360.0
    return y


def _ang_diff_deg(a: float, b: float) -> float:
    d = (a - b + 180.0) % 360.0 - 180.0
    return d


def _scene_intensity(theta_deg: float, phase_deg: float, contrast: float) -> float:
    if VISUAL_MODE == "bar":
        d = abs(_ang_diff_deg(theta_deg, phase_deg))
        return 1.0 if d <= (BAR_WIDTH_DEG / 2.0) else 0.0
    x = math.radians(theta_deg + phase_deg)
    s = (
        0.55
        + 0.20 * math.sin(x + 0.4)
        + 0.15 * math.sin(3.0 * x - 0.9)
        + 0.10 * math.cos(5.0 * x + 1.7)
    )
    # Two bright landmarks to mimic salient scene features.
    for center, amp, sigma in [(40.0, 0.35, 10.0), (210.0, 0.28, 14.0)]:
        d = _ang_diff_deg(theta_deg + phase_deg, center)
        s += amp * math.exp(-(d * d) / (2.0 * sigma * sigma))
    s = 0.5 + contrast * (s - 0.5)
    return max(0.0, min(1.0, s))


def _rf_activation(center_deg: float, phase_deg: float, sigma_deg: float, fov_deg: float, contrast: float) -> float:
    # Integrate synthetic panorama through Gaussian RF around center angle.
    half = fov_deg / 2.0
    # Sample every 6 degrees for speed; enough for smooth RF currents.
    step = 6.0
    total_w = 0.0
    total_v = 0.0
    theta = -half
    while theta <= half:
        world_deg = _wrap_deg(center_deg + theta)
        d = theta
        w = math.exp(-(d * d) / (2.0 * sigma_deg * sigma_deg))
        v = _scene_intensity(world_deg, phase_deg, contrast)
        total_w += w
        total_v += w * v
        theta += step
    if total_w <= 0:
        return 0.0
    return max(0.0, min(1.0, total_v / total_w))


def _norm_clip_nonneg(xs: list[float]) -> list[float]:
    if not xs:
        return []
    mn = min(xs)
    mx = max(xs)
    if mx - mn < 1e-9:
        return [0.0 for _ in xs]
    out = [((x - mn) / (mx - mn) * 2.0) - 1.0 for x in xs]
    return [x if x > 0.0 else 0.0 for x in out]


def _epg_heading_and_width(epg_ids: list[str], epg_label_map: dict[str, str]) -> tuple[float | None, int]:
    angles = []
    for rid in epg_ids:
        lbl = epg_label_map.get(rid)
        if not lbl:
            continue
        ang = EPG_LABEL_TO_ANGLE.get(lbl)
        if ang is not None:
            angles.append(ang)
    if not angles:
        return None, 0
    cx = sum(math.cos(a) for a in angles) / len(angles)
    cy = sum(math.sin(a) for a in angles) / len(angles)
    heading = math.atan2(cy, cx)
    if heading < 0:
        heading += 2.0 * math.pi
    return heading, len(set(angles))


def main() -> int:
    if not (1 <= LEARN_TICKS < TICKS):
        raise ValueError("NEUROSIM_EXPORT_LEARN_TICKS must be between 1 and TICKS-1")
    if PEN_DIRECTION not in {"cw", "ccw"}:
        raise ValueError("NEUROSIM_EXPORT_PEN_DIRECTION must be 'cw' or 'ccw'")

    out_replay = ROOT / "world" / "public" / f"{SCENARIO_ID}_replay.json"
    out_timeline = ROOT / "world" / "public" / f"{SCENARIO_ID}_timeline.csv"
    out_summary = ROOT / "logs" / f"{SCENARIO_ID}_summary.json"
    out_replay.parent.mkdir(parents=True, exist_ok=True)
    out_timeline.parent.mkdir(parents=True, exist_ok=True)
    out_summary.parent.mkdir(parents=True, exist_ok=True)

    epg_entries = json.loads((ROOT / "data" / "epg-tile-map.json").read_text(encoding="utf-8"))["entries"]
    epg_set = {str(e["root_id"]) for e in epg_entries}

    class_map: dict[str, dict[str, str]] = {}
    with (ROOT / "data" / "raw" / "classification.csv").open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = row.get("root_id", "")
            if rid:
                class_map[rid] = row

    ring_ids = sorted(
        {
            rid
            for rid, row in class_map.items()
            if (row.get("class") or "").strip() == "CX"
            and (row.get("sub_class") or "").strip() == "ring_neuron"
            and (
                (row.get("hemibrain_type") or "").startswith("ER2")
                or (row.get("hemibrain_type") or "").startswith("ER4")
            )
        }
    )
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
    ring_center_deg = {
        rid: (360.0 * i / max(1, len(ring_ids)))
        for i, rid in enumerate(ring_ids)
    }
    ring_kind = {
        rid: ("R2" if (class_map.get(rid, {}).get("hemibrain_type", "").startswith("ER2")) else "R4")
        for rid in ring_ids
    }
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

    ticks: list[dict[str, object]] = []
    epg_unique: set[str] = set()
    epg_events = 0
    learning_weight_mean_sum = 0.0
    learning_weight_mean_count = 0
    probe_weight_mean_sum = 0.0
    probe_weight_mean_count = 0
    headings_rad: list[float | None] = []
    bump_widths: list[int] = []

    rpc = Rpc(SOCKET_PATH)
    try:
        rpc.request("ping")
        sim_id = int(rpc.request("create")["sim_id"])
        batch = 100
        for start in range(0, TICKS, batch):
            take = min(batch, TICKS - start)
            steps = []
            for i in range(start, start + take):
                tick = i + 1
                learning_active = tick <= LEARN_TICKS
                probe_phase = not learning_active
                external_current_by_id: dict[str, float] = {}

                phase_deg = (tick - 1) * VISUAL_DEG_PER_TICK
                r2_ids = [rid for rid in ring_ids if ring_kind[rid] == "R2"]
                r4_ids = [rid for rid in ring_ids if ring_kind[rid] == "R4"]
                raw_r2 = []
                raw_r4 = []
                for rid in r2_ids:
                    center = ring_center_deg[rid]
                    act = _rf_activation(center, phase_deg, RING_RF_SIGMA_DEG, VISUAL_FOV_DEG, VISUAL_CONTRAST)
                    raw_r2.append(act)
                for rid in r4_ids:
                    center = ring_center_deg[rid]
                    act = _rf_activation(center, phase_deg, RING_RF_SIGMA_DEG, VISUAL_FOV_DEG, VISUAL_CONTRAST)
                    raw_r4.append(act)
                act_r2 = _norm_clip_nonneg(raw_r2)
                act_r4 = _norm_clip_nonneg(raw_r4)
                for rid, a in zip(r2_ids, act_r2):
                    external_current_by_id[rid] = RING_BASE_CURRENT + (RING_VISUAL_GAIN * RING_SCALE * a)
                for rid, a in zip(r4_ids, act_r4):
                    external_current_by_id[rid] = RING_BASE_CURRENT + (RING_VISUAL_GAIN * RING_SCALE * a)

                phase_scale = PEN_PROBE_SCALE if probe_phase else 1.0
                left_val = phase_scale * (PEN_BASE_CURRENT + left_sign * PEN_BIAS_CURRENT)
                right_val = phase_scale * (PEN_BASE_CURRENT + right_sign * PEN_BIAS_CURRENT)
                for rid in pen_left_ids:
                    external_current_by_id[rid] = left_val
                for rid in pen_right_ids:
                    external_current_by_id[rid] = right_val

                steps.append(
                    {
                        "sim_id": sim_id,
                        "dt": DT_SEC,
                        "include_activity": True,
                        "global_external_current": GLOBAL_BASE_CURRENT,
                        "external_current_by_id": external_current_by_id,
                        "ring_epg_plasticity": {
                            "enabled": True,
                            "learning_active": learning_active,
                            "gain": PLASTIC_GAIN,
                            "eta": PLASTIC_ETA,
                            "w_min": PLASTIC_W_MIN,
                            "w_max": PLASTIC_W_MAX,
                            "init_min": PLASTIC_INIT_MIN,
                            "init_max": PLASTIC_INIT_MAX,
                        },
                        "fly": {
                            "x": 0,
                            "y": 0,
                            "z": 0.35,
                            "heading": 0,
                            "t": i * DT_SEC,
                            "hunger": 40,
                            "health": 100,
                            "rest_time_left": 0,
                            "dead": False,
                        },
                    }
                )

            res = rpc.request("step_many", {"steps": steps})
            for k, item in enumerate(res.get("results", []), start=1):
                tick = start + k
                epg_ids = sorted([str(rid) for rid in (item.get("activity_sparse") or {}).keys() if str(rid) in epg_set])
                ticks.append({"tick": tick, "time_sec": tick * DT_SEC, "spikes": epg_ids})
                epg_unique.update(epg_ids)
                epg_events += len(epg_ids)
                heading, width = _epg_heading_and_width(epg_ids, epg_label_map)
                headings_rad.append(heading)
                bump_widths.append(width)

                w_mean = float(item.get("ring_epg_weight_mean", 0.0))
                if tick <= LEARN_TICKS:
                    learning_weight_mean_sum += w_mean
                    learning_weight_mean_count += 1
                else:
                    probe_weight_mean_sum += w_mean
                    probe_weight_mean_count += 1
    finally:
        rpc.close()

    replay_neurons = []
    for e in epg_entries:
        rid = str(e["root_id"])
        c = class_map.get(rid, {})
        replay_neurons.append(
            {
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
            }
        )

    replay = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source_csv": str(out_timeline),
            "ticks": TICKS,
            "dt_sec": DT_SEC,
            "scenario": SCENARIO_ID,
            "stimulus": {
                "pen_direction": PEN_DIRECTION,
                "pen_base_current": PEN_BASE_CURRENT,
                "pen_bias_current": PEN_BIAS_CURRENT,
                "pen_probe_scale": PEN_PROBE_SCALE,
                "ring_base_current": RING_BASE_CURRENT,
                "ring_visual_gain": RING_VISUAL_GAIN,
                "ring_scale": RING_SCALE,
                "ring_rf_sigma_deg": RING_RF_SIGMA_DEG,
                "visual_deg_per_tick": VISUAL_DEG_PER_TICK,
                "visual_fov_deg": VISUAL_FOV_DEG,
                "visual_contrast": VISUAL_CONTRAST,
                "visual_mode": VISUAL_MODE,
                "bar_width_deg": BAR_WIDTH_DEG,
                "global_base_current": GLOBAL_BASE_CURRENT,
                "learn_ticks": LEARN_TICKS,
                "probe_ticks": TICKS - LEARN_TICKS,
                "ring_pool_size": len(ring_ids),
                "pen_left_pool_size": len(pen_left_ids),
                "pen_right_pool_size": len(pen_right_ids),
                "plasticity": {
                    "gain": PLASTIC_GAIN,
                    "eta": PLASTIC_ETA,
                    "w_min": PLASTIC_W_MIN,
                    "w_max": PLASTIC_W_MAX,
                    "init_min": PLASTIC_INIT_MIN,
                    "init_max": PLASTIC_INIT_MAX,
                },
            },
            "observed": {
                "epg_spike_events_total": epg_events,
                "epg_unique_fired_total": len(epg_unique),
                "ring_epg_weight_mean_learning": (
                    learning_weight_mean_sum / learning_weight_mean_count
                    if learning_weight_mean_count else 0.0
                ),
                "ring_epg_weight_mean_probe": (
                    probe_weight_mean_sum / probe_weight_mean_count
                    if probe_weight_mean_count else 0.0
                ),
            },
        },
        "neurons": replay_neurons,
        "ticks": ticks,
    }
    probe_pairs = [(i, h) for i, h in enumerate(headings_rad, start=1) if i > LEARN_TICKS and h is not None]
    probe_indices = [i for i, _ in probe_pairs]
    probe_headings = [h for _, h in probe_pairs]
    if probe_headings:
        cx = sum(math.cos(h) for h in probe_headings) / len(probe_headings)
        cy = sum(math.sin(h) for h in probe_headings) / len(probe_headings)
        r = math.sqrt(cx * cx + cy * cy)
        circular_variance = 1.0 - r
        start_h = probe_headings[0]
        unwrapped = [start_h]
        for h in probe_headings[1:]:
            prev = unwrapped[-1]
            d = (h - (prev % (2.0 * math.pi)) + math.pi) % (2.0 * math.pi) - math.pi
            unwrapped.append(prev + d)
        total_dt = max(1e-9, (probe_indices[-1] - probe_indices[0]) * DT_SEC)
        drift_per_sec = (unwrapped[-1] - unwrapped[0]) / total_dt
    else:
        circular_variance = 1.0
        drift_per_sec = 0.0
    width_vals = [w for i, w in enumerate(bump_widths, start=1) if i > LEARN_TICKS and w > 0]
    replay["meta"]["observed"]["bump_width_mean_probe"] = (
        sum(width_vals) / len(width_vals) if width_vals else 0.0
    )
    replay["meta"]["observed"]["circular_variance_probe"] = circular_variance
    replay["meta"]["observed"]["drift_rad_per_sec_probe"] = drift_per_sec

    out_replay.write_text(json.dumps(replay) + "\n", encoding="utf-8")

    with out_timeline.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["tick", "phase", "time_sec", "epg_spike_count", "epg_spike_ids"])
        for row in ticks:
            tick = int(row["tick"])
            phase = "learn" if tick <= LEARN_TICKS else "probe"
            ids = row["spikes"]
            w.writerow([tick, phase, f"{row['time_sec']:.6f}", len(ids), "|".join(ids)])

    summary = {
        "scenario": SCENARIO_ID,
        "outputs": {
            "replay_json": str(out_replay),
            "timeline_csv": str(out_timeline),
        },
        "observed": replay["meta"]["observed"],
    }
    out_summary.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
