#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from rpc import Rpc

ROOT = Path(__file__).resolve().parents[1]
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", "/tmp/neurosim-brain.sock"))

TICKS = int(os.environ.get("NEUROSIM_EXPORT_TICKS", "1000"))
DT_MS = float(os.environ.get("NEUROSIM_EXPORT_DT_MS", "1.0"))
DT_SEC = DT_MS / 1000.0
HZ = float(os.environ.get("NEUROSIM_EXPORT_STIM_HZ", "600.0"))
OLFACTORY_BASE_HZ = float(os.environ.get("NEUROSIM_EXPORT_OLFACTORY_BASE_HZ", "0.0"))
PEN_CURRENT = float(os.environ.get("NEUROSIM_EXPORT_PEN_CURRENT", "5.0"))
PEN_BASE_CURRENT = float(os.environ.get("NEUROSIM_EXPORT_PEN_BASE_CURRENT", "0.0"))
PEN_DIRECTION = os.environ.get("NEUROSIM_EXPORT_PEN_DIRECTION", "cw").strip().lower()

AFF10 = [
    720575940626768442,
    720575940628644239,
    720575940622303446,
    720575940623302988,
    720575940623758377,
    720575940609713710,
    720575940612358642,
    720575940631844300,
    720575940622416628,
    720575940632875746,
]


def _tag_value(x: float) -> str:
    return f"{x:g}".replace(".", "p")


SCENARIO_ID = (
    f"neurosim_epg_aff10_{_tag_value(HZ)}hz_olf{_tag_value(OLFACTORY_BASE_HZ)}hz_"
    f"pythonbrain_penbias_{PEN_DIRECTION}_base{_tag_value(PEN_BASE_CURRENT)}_"
    f"cur{_tag_value(PEN_CURRENT)}_{TICKS}ticks"
)


def main() -> int:
    out_replay = ROOT / "world" / "public" / f"{SCENARIO_ID}_replay.json"
    out_timeline = ROOT / "world" / "public" / f"{SCENARIO_ID}_timeline.csv"
    out_aff = ROOT / "world" / "public" / f"{SCENARIO_ID}_stimulated-afferents.csv"
    out_summary = ROOT / "logs" / f"{SCENARIO_ID}_summary.json"

    epg_entries = json.loads((ROOT / "data" / "epg-tile-map.json").read_text(encoding="utf-8"))["entries"]
    epg_set = {str(e["root_id"]) for e in epg_entries}
    aff_set = {str(x) for x in AFF10}

    class_map: dict[str, dict[str, str]] = {}
    with (ROOT / "data" / "raw" / "classification.csv").open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = row.get("root_id", "")
            if rid:
                class_map[rid] = row

    if PEN_DIRECTION not in {"cw", "ccw"}:
        raise ValueError("NEUROSIM_EXPORT_PEN_DIRECTION must be 'cw' or 'ccw'")

    pen_left_ids = sorted(
        {
            str(row["root_id"])
            for row in class_map.values()
            if row.get("root_id")
            and ("PEN" in (row.get("hemibrain_type") or ""))
            and (row.get("side") or "").strip().lower() == "left"
        }
    )
    pen_right_ids = sorted(
        {
            str(row["root_id"])
            for row in class_map.values()
            if row.get("root_id")
            and ("PEN" in (row.get("hemibrain_type") or ""))
            and (row.get("side") or "").strip().lower() == "right"
        }
    )
    pen_ids = sorted(set(pen_left_ids + pen_right_ids))

    stim_rates_by_id = {str(x): HZ for x in AFF10}
    left_sign = 1.0 if PEN_DIRECTION == "cw" else -1.0
    right_sign = -1.0 if PEN_DIRECTION == "cw" else 1.0
    external_current_by_id = {}
    for rid in pen_left_ids:
        external_current_by_id[rid] = PEN_BASE_CURRENT + (left_sign * PEN_CURRENT)
    for rid in pen_right_ids:
        external_current_by_id[rid] = PEN_BASE_CURRENT + (right_sign * PEN_CURRENT)

    ticks: list[dict[str, object]] = []
    all_unique: set[str] = set()
    epg_unique: set[str] = set()
    aff_unique: set[str] = set()
    epg_events = 0
    aff_events = 0

    rpc = Rpc(SOCKET_PATH)
    try:
        rpc.request("ping")
        sim_id = int(rpc.request("create")["sim_id"])
        batch = 100
        for start in range(0, TICKS, batch):
            take = min(batch, TICKS - start)
            steps = []
            for i in range(start, start + take):
                steps.append(
                    {
                        "sim_id": sim_id,
                        "dt": DT_SEC,
                        "include_activity": True,
                        "olfactory_baseline_rate_hz": OLFACTORY_BASE_HZ,
                        "stim_rates_by_id": stim_rates_by_id,
                        "external_current_by_id": external_current_by_id,
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
                t = start + k
                epg_ids = sorted([str(rid) for rid in (item.get("activity_sparse") or {}).keys() if str(rid) in epg_set])
                ticks.append({"tick": t, "time_sec": t * DT_SEC, "spikes": epg_ids})
                all_unique.update(epg_ids)
                epg_unique.update(epg_ids)
                epg_events += len(epg_ids)

                step_aff_ids = [str(rid) for rid in item.get("afferent_spike_ids_step", [])]
                aff_events += sum(1 for rid in step_aff_ids if rid in aff_set)
                aff_unique.update([rid for rid in step_aff_ids if rid in aff_set])
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
                "flow": c.get("flow", ""),
                "super_class": c.get("super_class", ""),
                "class": c.get("class", ""),
                "sub_class": c.get("sub_class", ""),
                "cell_type": c.get("cell_type", ""),
                "hemilineage": c.get("hemilineage", ""),
                "nerve": c.get("nerve", ""),
            }
        )

    replay = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source_csv": str(out_timeline),
            "ticks": TICKS,
            "unique_fired_neurons": len(all_unique),
            "ring_neuron_total": len(replay_neurons),
            "ring_neuron_unique_fired": len(epg_unique),
            "dt_sec": DT_SEC,
            "epg_neuron_total": len(replay_neurons),
            "epg_neuron_unique_fired": len(epg_unique),
            "scenario": SCENARIO_ID,
            "stimulus": {
                "stim_rate_hz": HZ,
                "olfactory_base_hz": OLFACTORY_BASE_HZ,
                "pen_current": PEN_CURRENT,
                "pen_base_current": PEN_BASE_CURRENT,
                "pen_direction": PEN_DIRECTION,
                "pen_left_pool_size": len(pen_left_ids),
                "pen_right_pool_size": len(pen_right_ids),
                "pen_pool_size": len(pen_ids),
                "dt_ms": DT_MS,
                "stimulated_afferent_ids": [str(x) for x in AFF10],
            },
            "observed": {
                "epg_spike_events": epg_events,
                "epg_unique_fired": len(epg_unique),
                "stim_afferent_spike_events": aff_events,
                "stim_afferent_unique_fired": len(aff_unique),
            },
        },
        "neurons": replay_neurons,
        "ticks": ticks,
    }
    out_replay.write_text(json.dumps(replay) + "\n", encoding="utf-8")

    with out_timeline.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["tick", "time_sec", "epg_spike_count", "epg_spike_ids"])
        for row in ticks:
            ids = row["spikes"]
            w.writerow([row["tick"], f"{row['time_sec']:.6f}", len(ids), "|".join(ids)])

    with out_aff.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["root_id", "flow", "super_class", "class", "sub_class", "cell_type", "is_olfactory_afferent"])
        for rid in [str(x) for x in AFF10]:
            c = class_map.get(rid, {})
            is_olf = c.get("flow", "") == "afferent" and c.get("class", "") == "olfactory"
            w.writerow(
                [
                    rid,
                    c.get("flow", ""),
                    c.get("super_class", ""),
                    c.get("class", ""),
                    c.get("sub_class", ""),
                    c.get("cell_type", ""),
                    "true" if is_olf else "false",
                ]
            )

    summary = {
        "scenario": SCENARIO_ID,
        "outputs": {
            "replay_json": str(out_replay),
            "timeline_csv": str(out_timeline),
            "stimulated_afferents_csv": str(out_aff),
        },
        "observed": {
            "epg_spike_events": epg_events,
            "epg_unique_fired": len(epg_unique),
            "stim_afferent_spike_events": aff_events,
            "stim_afferent_unique_fired": len(aff_unique),
        },
    }
    out_summary.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
