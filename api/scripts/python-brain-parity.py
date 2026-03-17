#!/usr/bin/env python3
from __future__ import annotations

import json
import socket
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LOGS = ROOT / "logs"
SOCKET_PATH = Path("/tmp/neurosim-brain.sock")
DT_SEC = 0.0001
TICKS = 1000
TICKS_300 = 300
FLY_CSV = LOGS / "python_brain_parity_flybrain_t0p1.csv"
REPORT_300 = LOGS / "python_brain_parity_300.json"
REPORT_1000 = LOGS / "python_brain_parity_1000.json"
SUMMARY = LOGS / "python_brain_parity_summary.txt"
PARQUET_PATH = ROOT.parent / "fly-brain" / "data" / "results" / "pytorch_t0.1s_n1.parquet"

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
    parsed = json.loads((ROOT / "world" / "public" / "epg-tile-map.json").read_text("utf-8"))
    return {
        str(row.get("root_id", ""))
        for row in parsed.get("entries", [])
        if str(row.get("root_id", ""))
    }


def parse_fly_ticks(epg_ids: set[str]) -> list[list[str]]:
    import csv

    out = [set() for _ in range(TICKS)]
    with FLY_CSV.open("r", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            rid = str(row.get("flywire_id", ""))
            if rid not in epg_ids:
                continue
            t = float(row.get("t", "0"))
            tick = round(t / DT_SEC) + 1
            if 1 <= tick <= TICKS:
                out[tick - 1].add(rid)
    return [sorted(s) for s in out]


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


def run_python_ticks(epg_ids: set[str]) -> list[list[str]]:
    rpc = Rpc(SOCKET_PATH)
    try:
        rpc.request("ping")
        created = rpc.request("create")
        sim_id = int(created["sim_id"])
        out: list[list[str]] = []
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
                out.append(sorted(ids))
        return out
    finally:
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
    fly_ticks = parse_fly_ticks(epg_ids)
    py_ticks = run_python_ticks(epg_ids)
    report300 = compare(fly_ticks, py_ticks, TICKS_300)
    report1000 = compare(fly_ticks, py_ticks, TICKS)
    REPORT_300.write_text(json.dumps(report300, indent=2) + "\n", encoding="utf-8")
    REPORT_1000.write_text(json.dumps(report1000, indent=2) + "\n", encoding="utf-8")
    summary = "\n".join([
        "python-brain parity summary",
        f"300_exact_tick_ratio={report300['exact_tick_ratio']:.4f}",
        f"300_event_jaccard={report300['event_jaccard']:.4f}",
        f"1000_exact_tick_ratio={report1000['exact_tick_ratio']:.4f}",
        f"1000_event_jaccard={report1000['event_jaccard']:.4f}",
        f"flybrain_csv={FLY_CSV}",
        f"report_300={REPORT_300}",
        f"report_1000={REPORT_1000}",
    ])
    SUMMARY.write_text(summary + "\n", encoding="utf-8")
    print(summary)


if __name__ == "__main__":
    main()
