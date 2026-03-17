#!/usr/bin/env python3
"""
Run fly-brain baseline tiers directly (no neurosim API/brain-service) and export CSVs.

Outputs:
- world/public/eonsystems_flybrain_baseline_1ms_tier{1,2,3}_spikes.csv
- logs/eonsystems_flybrain_baseline_1ms_tier{1,2,3}_summary.txt
"""

from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path

import pandas as pd
import torch


def parse_int_list(value: str) -> list[int]:
    out: list[int] = []
    for part in value.split(","):
        token = part.strip()
        if not token:
            continue
        out.append(int(token))
    return out


def parse_float_list(value: str) -> list[float]:
    out: list[float] = []
    for part in value.split(","):
        token = part.strip()
        if not token:
            continue
        out.append(float(token))
    return out


def main() -> None:
    script_path = Path(__file__).resolve()
    repo_root = script_path.parent.parent
    fly_brain_dir = Path(os.environ.get("FLY_BRAIN_DIR", str((repo_root / "../fly-brain").resolve()))).resolve()

    sys.path.insert(0, str(fly_brain_dir / "code"))
    from run_pytorch import get_hash_tables, get_weights, TorchModel, MODEL_PARAMS  # type: ignore
    from benchmark import path_comp, path_con, path_wt  # type: ignore

    dt_ms = float(os.environ.get("DT_MS", "1.0"))
    ticks = int(os.environ.get("TICKS", "2000"))
    n_run = int(os.environ.get("N_RUN", "1"))
    t_run_sec = (ticks * dt_ms) / 1000.0

    stim_scope = os.environ.get("STIM_SCOPE", "global").strip().lower()
    stim_ids: list[int] = []
    if "STIM_IDS" in os.environ and os.environ["STIM_IDS"].strip():
        stim_ids = parse_int_list(os.environ["STIM_IDS"])
        stim_scope = "ids"

    tier_hz = parse_float_list(os.environ.get("TIER_HZ", "10,30,50"))
    if len(tier_hz) != 3:
        raise RuntimeError(f"TIER_HZ must contain exactly 3 comma-separated values, got: {tier_hz}")
    device = "cuda" if torch.cuda.is_available() else "cpu"

    flyid2i, i2flyid = get_hash_tables(str(path_comp))
    weights = get_weights(str(path_con), str(path_comp), str(path_wt), csr=True).to(device=device)
    neuron_count = int(weights.shape[0])

    if stim_scope == "global":
        stim_indices = list(range(neuron_count))
    elif stim_scope == "ids":
        missing_stim_ids = [i for i in stim_ids if i not in flyid2i]
        if missing_stim_ids:
            warnings.warn(
                "Requested STIM_IDS missing from fly-brain completeness table: "
                + ",".join(str(i) for i in missing_stim_ids),
                RuntimeWarning,
            )
        stim_indices = [flyid2i[i] for i in stim_ids if i in flyid2i]
        if not stim_indices:
            raise RuntimeError("No stimulation IDs were found in fly-brain completeness table.")
    else:
        raise RuntimeError(f"Unsupported STIM_SCOPE='{stim_scope}'. Use 'global' or provide STIM_IDS.")

    public_dir = repo_root / "world" / "public"
    logs_dir = repo_root / "logs"
    public_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)

    for tier_idx, hz in enumerate(tier_hz, start=1):
        rates = torch.zeros(n_run, neuron_count, device=device)
        rates[:, stim_indices] = hz

        model = TorchModel(n_run, neuron_count, dt_ms, MODEL_PARAMS, weights, device=device)
        conductance, delay_buffer, spikes, v, refrac = model.state_init()

        rows: list[tuple[int, float, int, int]] = []
        with torch.no_grad():
            for step in range(ticks):
                conductance, delay_buffer, spikes, v, refrac = model(
                    rates, conductance, delay_buffer, spikes, v, refrac
                )
                mask = spikes > 0
                if not mask.any():
                    continue
                b_idx, n_idx = mask.nonzero(as_tuple=True)
                t_ms = step * dt_ms
                rows.extend(
                    (step + 1, t_ms, int(b), int(i2flyid[int(n)]))
                    for b, n in zip(b_idx.tolist(), n_idx.tolist(), strict=True)
                )

        df = pd.DataFrame(rows, columns=["tick", "time_ms", "trial", "flywire_id"])
        unique_neurons = int(df["flywire_id"].nunique()) if len(df) else 0

        out_csv = public_dir / f"eonsystems_flybrain_baseline_1ms_tier{tier_idx}_spikes.csv"
        out_summary = logs_dir / f"eonsystems_flybrain_baseline_1ms_tier{tier_idx}_summary.txt"
        df.to_csv(out_csv, index=False)

        summary_lines = [
            f"fly-brain baseline tier {tier_idx}",
            f"device: {device}",
            f"dt_ms: {dt_ms}",
            f"ticks: {ticks}",
            f"t_run_sec: {t_run_sec}",
            f"n_run: {n_run}",
            f"stim_scope: {stim_scope}",
            f"stim_hz: {hz}",
            f"stim_id_count: {len(stim_indices)}",
            f"total_spikes: {len(df)}",
            f"unique_fired_neurons: {unique_neurons}",
            f"csv_path: {out_csv}",
        ]
        out_summary.write_text("\n".join(summary_lines) + "\n", encoding="utf-8")
        print("\n".join(summary_lines))
        print("")


if __name__ == "__main__":
    main()
