#!/usr/bin/env python3
from __future__ import annotations

import csv
import os
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import torch


ROOT = Path(__file__).resolve().parents[1]
FLY = ROOT.parent / "fly-brain-fresh"

TICKS = int(os.environ.get("NEUROSIM_EXPORT_TICKS", "1000"))
DT_MS = float(os.environ.get("NEUROSIM_EXPORT_DT_MS", "1.0"))
DT_SEC = DT_MS / 1000.0
HZ = float(os.environ.get("NEUROSIM_EXPORT_STIM_HZ", "600.0"))
OLFACTORY_BASE_HZ = float(os.environ.get("NEUROSIM_EXPORT_OLFACTORY_BASE_HZ", "0.0"))
SEED = int(os.environ.get("NEUROSIM_EXPORT_SEED", "123"))
SCENARIO_ID = f"neurosim_epg_aff10_600hz_olf{int(OLFACTORY_BASE_HZ)}hz_{TICKS}ticks"

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
DRV10 = [
    720575940624452902,
    720575940617672226,
    720575940640749939,
    720575940642855328,
    720575940627264062,
    720575940612937073,
    720575940625653223,
    720575940610980932,
    720575940619845547,
    720575940624323475,
]


def main() -> int:
    sys.path.insert(0, str(FLY / "code"))
    import run_pytorch  # type: ignore
    from benchmark import path_comp, path_con, path_wt  # type: ignore

    out_replay = ROOT / "world" / "public" / f"{SCENARIO_ID}_replay.json"
    out_timeline = ROOT / "world" / "public" / f"{SCENARIO_ID}_timeline.csv"
    out_aff = ROOT / "world" / "public" / f"{SCENARIO_ID}_stimulated-afferents.csv"
    out_summary = ROOT / "logs" / f"{SCENARIO_ID}_summary.json"

    epg_entries = json.loads((ROOT / "data" / "epg-tile-map.json").read_text(encoding="utf-8"))["entries"]
    epg_ids = sorted({int(e["root_id"]) for e in epg_entries})
    olf_map = json.loads((ROOT / "data" / "olfactory-afferents.json").read_text(encoding="utf-8"))
    olf_ids = sorted(
        {
            int(x)
            for x in (
                list(olf_map.get("left", []))
                + list(olf_map.get("right", []))
                + list(olf_map.get("unknown", []))
            )
        }
    )

    class_map: dict[str, dict[str, str]] = {}
    with (ROOT / "data" / "raw" / "classification.csv").open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = row.get("root_id", "")
            if rid:
                class_map[rid] = row

    run_pytorch.DT = DT_MS
    flyid2i, i2flyid = run_pytorch.get_hash_tables(str(path_comp))
    weights = run_pytorch.get_weights(str(path_con), str(path_comp), str(path_wt), csr=True).to("cpu")
    model = run_pytorch.TorchModel(1, weights.shape[0], DT_MS, run_pytorch.MODEL_PARAMS, weights, device="cpu")

    aff_idx = [flyid2i[x] for x in AFF10 if x in flyid2i]
    olf_idx = [flyid2i[x] for x in olf_ids if x in flyid2i]
    drv_idx = [flyid2i[x] for x in DRV10 if x in flyid2i]
    epg_idx = [flyid2i[x] for x in epg_ids if x in flyid2i]
    aff_set = {str(x) for x in AFF10}
    drv_set = {str(x) for x in DRV10}
    epg_set = {str(x) for x in epg_ids}

    conductance, delay_buffer, spikes, v, refrac = model.state_init()
    rates = torch.zeros(1, weights.shape[0])
    if OLFACTORY_BASE_HZ > 0 and olf_idx:
        rates[:, olf_idx] = OLFACTORY_BASE_HZ
    rates[:, aff_idx] = HZ
    gen = torch.Generator(device="cpu")
    gen.manual_seed(SEED)

    ticks: list[dict[str, object]] = []
    all_unique: set[str] = set()
    epg_unique: set[str] = set()
    drv_unique: set[str] = set()
    aff_unique: set[str] = set()
    epg_events = drv_events = aff_events = 0

    with torch.no_grad():
        for t in range(1, TICKS + 1):
            conductance, delay_buffer, spikes, v, refrac = model(
                rates, conductance, delay_buffer, spikes, v, refrac, generator=gen
            )
            spike_idx = spikes[0].nonzero(as_tuple=False).flatten().tolist()
            spike_ids = sorted([str(i2flyid[int(i)]) for i in spike_idx])
            ticks.append({"tick": t, "time_sec": t * DT_SEC, "spikes": spike_ids})
            all_unique.update(spike_ids)
            for sid in spike_ids:
                if sid in epg_set:
                    epg_events += 1
                    epg_unique.add(sid)
                if sid in drv_set:
                    drv_events += 1
                    drv_unique.add(sid)
                if sid in aff_set:
                    aff_events += 1
                    aff_unique.add(sid)

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
                "olfactory_pool_size": len(olf_idx),
                "dt_ms": DT_MS,
                "seed": SEED,
                "stimulated_afferent_ids": [str(x) for x in AFF10],
                "driver_ids": [str(x) for x in DRV10],
            },
            "observed": {
                "epg_spike_events": epg_events,
                "epg_unique_fired": len(epg_unique),
                "driver_spike_events": drv_events,
                "driver_unique_fired": len(drv_unique),
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
        w.writerow(
            [
                "tick",
                "time_sec",
                "spike_count_total",
                "epg_spike_count",
                "driver_spike_count",
                "stim_afferent_spike_count",
                "spike_ids",
            ]
        )
        for row in ticks:
            ids = row["spikes"]
            w.writerow(
                [
                    row["tick"],
                    f"{row['time_sec']:.6f}",
                    len(ids),
                    sum(1 for x in ids if x in epg_set),
                    sum(1 for x in ids if x in drv_set),
                    sum(1 for x in ids if x in aff_set),
                    "|".join(ids),
                ]
            )

    with out_aff.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            ["root_id", "flow", "super_class", "class", "sub_class", "cell_type", "is_olfactory_afferent"]
        )
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

    expected = {"driver_spikes": 77, "epg_spikes": 16}
    overlap = {
        "expected_driver_spikes": expected["driver_spikes"],
        "actual_driver_spikes": drv_events,
        "driver_match": drv_events == expected["driver_spikes"],
        "expected_epg_spikes": expected["epg_spikes"],
        "actual_epg_spikes": epg_events,
        "epg_match": epg_events == expected["epg_spikes"],
    }
    summary = {
        "scenario": SCENARIO_ID,
        "outputs": {
            "replay_json": str(out_replay),
            "timeline_csv": str(out_timeline),
            "stimulated_afferents_csv": str(out_aff),
        },
        "overlap_with_fly_brain_expected": overlap,
    }
    out_summary.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

