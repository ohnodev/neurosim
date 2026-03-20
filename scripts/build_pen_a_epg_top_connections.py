#!/usr/bin/env python3
"""
Build a static frontend JSON with PEN_a -> EPG top links.

Output is consumed by world/public/pen_a_epg_top_connections.json.
No API/server changes required.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
NODES_CSV = ROOT / "world" / "public" / "neurosim_visualization_nodes.csv"
CONNECTOME_PARQUET = ROOT / "data" / "raw" / "2025_Connectivity_783.parquet"
OUTPUT_JSON = ROOT / "world" / "public" / "pen_a_epg_top_connections.json"


def load_nodes() -> tuple[list[dict[str, str]], dict[str, str]]:
    pen: list[dict[str, str]] = []
    epg_labels: dict[str, str] = {}
    with NODES_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            group = (row.get("group") or "").strip()
            neuron_id = (row.get("neuron_id") or "").strip()
            if not neuron_id:
                continue
            if group == "PEN_a":
                label = (row.get("mapping_label") or "").strip().upper()
                side = (row.get("side") or "").strip().lower()
                if len(label) >= 2 and label[0] in {"L", "R"} and label[1:].isdigit():
                    idx = int(label[1:])
                    expected_side = "left" if label[0] == "L" else "right"
                    if 1 <= idx <= 10 and side == expected_side:
                        pen.append({"id": neuron_id, "label": label, "side": side})
            elif group == "EPG":
                epg_labels[neuron_id] = (row.get("processed_label") or "").strip()
    pen.sort(key=lambda item: (0 if item["label"].startswith("L") else 1, int(item["label"][1:])))
    return pen, epg_labels


def main() -> None:
    pen, epg_labels = load_nodes()
    pen_ids = [int(item["id"]) for item in pen]
    epg_ids = [int(neuron_id) for neuron_id in epg_labels.keys()]

    table = pq.read_table(
        CONNECTOME_PARQUET,
        columns=["Presynaptic_ID", "Postsynaptic_ID", "Excitatory x Connectivity"],
    )
    mask = pc.and_(
        pc.is_in(table["Presynaptic_ID"], value_set=pa.array(pen_ids, type=pa.int64())),
        pc.is_in(table["Postsynaptic_ID"], value_set=pa.array(epg_ids, type=pa.int64())),
    )
    subset = table.filter(mask)

    by_pen: dict[str, list[tuple[str, float]]] = {item["id"]: [] for item in pen}
    for pre, post, weight in zip(
        subset["Presynaptic_ID"].to_pylist(),
        subset["Postsynaptic_ID"].to_pylist(),
        subset["Excitatory x Connectivity"].to_pylist(),
        strict=False,
    ):
        if pre is None or post is None or weight is None:
            continue
        by_pen[str(pre)].append((str(post), float(weight)))

    connections: list[dict[str, object]] = []
    used_proxy_inhibitory = False

    for item in pen:
        pen_id = item["id"]
        rows = by_pen.get(pen_id, [])
        strongest = sorted(rows, key=lambda pair: pair[1], reverse=True)[:5]

        inhibitory_candidates = [pair for pair in rows if pair[1] < 0]
        if len(inhibitory_candidates) >= 5:
            most_inhibitory = sorted(inhibitory_candidates, key=lambda pair: pair[1])[:5]
            proxy = False
        else:
            # Current PEN_a -> EPG subset has no negative signed edges in this parquet.
            # Fall back to the weakest links so UI still has 10 links per PEN_a.
            most_inhibitory = sorted(rows, key=lambda pair: pair[1])[:5]
            proxy = True
            used_proxy_inhibitory = True

        for rank, (epg_id, weight) in enumerate(strongest, start=1):
            connections.append(
                {
                    "pen_id": pen_id,
                    "pen_label": item["label"],
                    "pen_side": item["side"],
                    "epg_id": epg_id,
                    "epg_label": epg_labels.get(epg_id, ""),
                    "weight": weight,
                    "kind": "excitatory",
                    "rank": rank,
                    "is_proxy_inhibitory": False,
                }
            )

        for rank, (epg_id, weight) in enumerate(most_inhibitory, start=1):
            connections.append(
                {
                    "pen_id": pen_id,
                    "pen_label": item["label"],
                    "pen_side": item["side"],
                    "epg_id": epg_id,
                    "epg_label": epg_labels.get(epg_id, ""),
                    "weight": weight,
                    "kind": "unsigned_proxy" if proxy else "inhibitory",
                    "rank": rank,
                    "is_proxy_inhibitory": proxy,
                }
            )

    max_abs = max((abs(float(item["weight"])) for item in connections), default=1.0)
    for item in connections:
        item["strength01"] = round(abs(float(item["weight"])) / max_abs, 6)

    payload = {
        "meta": {
            "source_parquet": str(CONNECTOME_PARQUET.relative_to(ROOT)),
            "source_nodes_csv": str(NODES_CSV.relative_to(ROOT)),
            "focal_pen_neurons": pen,
            "per_pen_top_excitatory": 5,
            "per_pen_top_inhibitory": 5,
            "inhibitory_selection": (
                "signed-most-negative"
                if not used_proxy_inhibitory
                else "signed-most-negative-or-weakest-proxy-when-none"
            ),
            "total_connections": len(connections),
        },
        "connections": connections,
    }

    OUTPUT_JSON.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {OUTPUT_JSON} ({len(connections)} links)")


if __name__ == "__main__":
    main()
