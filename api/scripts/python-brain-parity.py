#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socket
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
LOGS = ROOT / "logs"
# Canonical EPG tile map (data/epg-tile-map.json); same as api/python-brain/service.py.
EPG_TILE_MAP_PATH = ROOT / "data" / "epg-tile-map.json"
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", "/tmp/neurosim-brain.sock"))
DT_SEC = 0.0001
TICKS = 1000
TICKS_300 = 300
FLY_CSV = LOGS / "python_brain_parity_flybrain_t0p1.csv"
REPORT_300 = LOGS / "python_brain_parity_300.json"
REPORT_1000 = LOGS / "python_brain_parity_1000.json"
SUMMARY = LOGS / "python_brain_parity_summary.txt"
PARQUET_PATH = ROOT.parent / "fly-brain" / "data" / "results" / "pytorch_t0.1s_n1.parquet"
OLFACTORY_AFFERENTS_PATH = ROOT / "data" / "olfactory-afferents.json"

SUGAR_IDS = [
    "720575940624963786", "720575940630233916", "720575940637568838", "720575940638202345",
    "720575940617000768", "720575940630797113", "720575940632889389", "720575940621754367",
    "720575940621502051", "720575940640649691", "720575940639332736", "720575940616885538",
    "720575940639198653", "720575940639259967", "720575940617937543", "720575940632425919",
    "720575940633143833", "720575940612670570", "720575940628853239", "720575940629176663",
    "720575940611875570",
]


def ensure_fly_csv() -> None:
    if FLY_CSV.exists():
        return
    import pandas as pd

    LOGS.mkdir(parents=True, exist_ok=True)
    df = pd.read_parquet(PARQUET_PATH).sort_values(["trial", "t", "flywire_id"]).reset_index(drop=True)
    df.to_csv(FLY_CSV, index=False)


def load_epg_ids() -> set[str]:
    parsed = json.loads(EPG_TILE_MAP_PATH.read_text("utf-8"))
    return {
        str(row.get("root_id", ""))
        for row in parsed.get("entries", [])
        if str(row.get("root_id", ""))
    }


def load_olfactory_afferent_ids() -> set[str]:
    parsed = json.loads(OLFACTORY_AFFERENTS_PATH.read_text("utf-8"))
    out: set[str] = set()

    def add_ids(entries: Any) -> None:
        if not isinstance(entries, list):
            if isinstance(entries, (str, int)):
                rid = str(entries)
                if rid:
                    out.add(rid)
            return
        for row in entries:
            if isinstance(row, dict):
                rid = str(row.get("root_id", row.get("id", "")))
                if rid:
                    out.add(rid)
            else:
                rid = str(row)
                if rid:
                    out.add(rid)

    if isinstance(parsed, list):
        add_ids(parsed)
    elif isinstance(parsed, dict):
        for val in parsed.values():
            add_ids(val)
    return out


def parse_fly_ticks(epg_ids: set[str], olfactory_ids: set[str]) -> dict:
    import csv

    epg_ticks = [set() for _ in range(TICKS)]
    olfactory_ticks = [set() for _ in range(TICKS)]
    all_ticks = [set() for _ in range(TICKS)]
    with FLY_CSV.open("r", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            rid = str(row.get("flywire_id", ""))
            t = float(row.get("t", "0"))
            tick = round(t / DT_SEC) + 1
            if 1 <= tick <= TICKS:
                all_ticks[tick - 1].add(rid)
                if rid in epg_ids:
                    epg_ticks[tick - 1].add(rid)
                if rid in olfactory_ids:
                    olfactory_ticks[tick - 1].add(rid)
    return {
        "epg": [sorted(s) for s in epg_ticks],
        "olfactory": [sorted(s) for s in olfactory_ticks],
        "all": [sorted(s) for s in all_ticks],
    }


class Rpc:
    def __init__(self, path: Path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(str(path))
        self.f = self.sock.makefile("rwb")

    def request(self, method: str, params: dict | None = None) -> dict:
        payload = {"method": method, "params": params or {}}
        self.f.write((json.dumps(payload) + "\n").encode("utf-8"))
        self.f.flush()
        line = self.f.readline()
        if not line:
            raise RuntimeError("socket closed")
        out = json.loads(line.decode("utf-8"))
        if isinstance(out, dict) and out.get("error"):
            raise RuntimeError(str(out["error"]))
        return out

    def close(self) -> None:
        try:
            self.f.close()
        finally:
            self.sock.close()


def run_python_ticks(epg_ids: set[str]) -> dict:
    rpc = Rpc(SOCKET_PATH)
    try:
        rpc.request("ping")
        created = rpc.request("create")
        sim_id = int(created["sim_id"])
        epg_ticks: list[list[str]] = []
        olfactory_ticks: list[list[str]] = []
        all_event_count = 0
        all_unique: set[str] = set()
        all_event_counts_by_tick: list[int] = []
        all_ids_by_tick: list[list[str]] = []
        stim_rates = {rid: 200.0 for rid in SUGAR_IDS}
        batch = 100
        for start in range(0, TICKS, batch):
            take = min(batch, TICKS - start)
            steps = []
            for i in range(start, start + take):
                steps.append({
                    "sim_id": sim_id,
                    "dt": DT_SEC,
                    "include_activity": True,
                    "stim_rates_by_id": stim_rates,
                    "fly": {
                        "x": 0, "y": 0, "z": 0.35, "heading": 0, "t": i * DT_SEC,
                        "hunger": 40, "health": 100, "rest_time_left": 0, "dead": False,
                    },
                    "sources": [],
                })
            res = rpc.request("step_many", {"steps": steps})
            for item in res.get("results", []):
                ids = [rid for rid in item.get("activity_sparse", {}).keys() if rid in epg_ids]
                epg_ticks.append(sorted(ids))
                olfactory_ids = [str(rid) for rid in item.get("olfactory_spike_ids_step", [])]
                olfactory_ticks.append(sorted(set(olfactory_ids)))
                tick_ids = sorted(set(str(rid) for rid in (item.get("spike_ids_step", []) or item.get("spike_ids", []) or list(item.get("activity_sparse", {}).keys()))))
                tick_events = int(item.get("total_spike_events_step", len(tick_ids)))
                all_event_count += tick_events
                all_event_counts_by_tick.append(tick_events)
                all_ids_by_tick.append(tick_ids)
                all_unique.update(tick_ids)
        return {
            "epg": epg_ticks,
            "olfactory": olfactory_ticks,
            "all_event_count": all_event_count,
            "all_unique_count": len(all_unique),
            "all_event_counts_by_tick": all_event_counts_by_tick,
            "all_ids_by_tick": all_ids_by_tick,
        }
    finally:
        try:
            rpc.request("reset", {})
        except Exception:
            pass
        rpc.close()


def compare(a: list[list[str]], b: list[list[str]], ticks: int) -> dict:
    exact = 0
    inter_total = 0
    union_total = 0
    per_tick = []
    for i in range(ticks):
        aa = set(a[i] if i < len(a) else [])
        bb = set(b[i] if i < len(b) else [])
        inter = len(aa.intersection(bb))
        union = len(aa.union(bb))
        if inter == len(aa) == len(bb):
            exact += 1
        inter_total += inter
        union_total += union
        per_tick.append({
            "tick": i + 1,
            "a_count": len(aa),
            "b_count": len(bb),
            "intersection": inter,
            "union": union,
            "jaccard": (inter / union) if union else 1.0,
        })
    return {
        "ticks_compared": ticks,
        "exact_tick_matches": exact,
        "exact_tick_ratio": (exact / ticks) if ticks else 0.0,
        "event_jaccard": (inter_total / union_total) if union_total else 1.0,
        "intersection_events": inter_total,
        "union_events": union_total,
        "per_tick": per_tick,
    }


def main() -> None:
    LOGS.mkdir(parents=True, exist_ok=True)
    ensure_fly_csv()
    epg_ids = load_epg_ids()
    olfactory_ids = load_olfactory_afferent_ids()
    fly = parse_fly_ticks(epg_ids, olfactory_ids)
    py = run_python_ticks(epg_ids)
    report300 = {
        "epg": compare(fly["epg"], py["epg"], TICKS_300),
        "olfactory": compare(fly["olfactory"], py["olfactory"], TICKS_300),
        "all": {
            "fly_event_count": sum(len(t) for t in fly["all"][:TICKS_300]),
            "fly_unique_count": len({rid for tick in fly["all"][:TICKS_300] for rid in tick}),
            "python_event_count": sum(py["all_event_counts_by_tick"][:TICKS_300]),
            "python_unique_count": len({rid for tick in py["all_ids_by_tick"][:TICKS_300] for rid in tick}),
            "event_count_delta": sum(py["all_event_counts_by_tick"][:TICKS_300]) - sum(len(t) for t in fly["all"][:TICKS_300]),
            "unique_count_delta": len({rid for tick in py["all_ids_by_tick"][:TICKS_300] for rid in tick})
            - len({rid for tick in fly["all"][:TICKS_300] for rid in tick}),
        },
    }
    report1000 = {
        "epg": compare(fly["epg"], py["epg"], TICKS),
        "olfactory": compare(fly["olfactory"], py["olfactory"], TICKS),
        "all": {
            "fly_event_count": sum(len(t) for t in fly["all"][:TICKS]),
            "fly_unique_count": len({rid for tick in fly["all"][:TICKS] for rid in tick}),
            "python_event_count": py["all_event_count"],
            "python_unique_count": py["all_unique_count"],
            "event_count_delta": py["all_event_count"] - sum(len(t) for t in fly["all"][:TICKS]),
            "unique_count_delta": py["all_unique_count"] - len({rid for tick in fly["all"][:TICKS] for rid in tick}),
        },
    }
    REPORT_300.write_text(json.dumps(report300, indent=2) + "\n", encoding="utf-8")
    REPORT_1000.write_text(json.dumps(report1000, indent=2) + "\n", encoding="utf-8")
    summary = "\n".join([
        "python-brain parity summary",
        f"300_epg_exact_tick_ratio={report300['epg']['exact_tick_ratio']:.4f}",
        f"300_epg_event_jaccard={report300['epg']['event_jaccard']:.4f}",
        f"300_olfactory_exact_tick_ratio={report300['olfactory']['exact_tick_ratio']:.4f}",
        f"300_olfactory_event_jaccard={report300['olfactory']['event_jaccard']:.4f}",
        f"1000_epg_exact_tick_ratio={report1000['epg']['exact_tick_ratio']:.4f}",
        f"1000_epg_event_jaccard={report1000['epg']['event_jaccard']:.4f}",
        f"1000_olfactory_exact_tick_ratio={report1000['olfactory']['exact_tick_ratio']:.4f}",
        f"1000_olfactory_event_jaccard={report1000['olfactory']['event_jaccard']:.4f}",
        f"1000_all_fly_event_count={report1000['all']['fly_event_count']}",
        f"1000_all_python_event_count={report1000['all']['python_event_count']}",
        f"1000_all_event_count_delta={report1000['all']['event_count_delta']}",
        f"1000_all_fly_unique_count={report1000['all']['fly_unique_count']}",
        f"1000_all_python_unique_count={report1000['all']['python_unique_count']}",
        f"1000_all_unique_count_delta={report1000['all']['unique_count_delta']}",
        f"flybrain_csv={FLY_CSV}",
        f"report_300={REPORT_300}",
        f"report_1000={REPORT_1000}",
    ])
    SUMMARY.write_text(summary + "\n", encoding="utf-8")
    print(summary)


if __name__ == "__main__":
    main()
