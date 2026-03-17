#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch


ROOT = Path(__file__).resolve().parents[2]
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", "/tmp/neurosim-brain.sock"))
BASE_SEED = int(os.environ.get("NEUROSIM_PYTHON_BRAIN_SEED", "1598276117"))
DEVICE_PREF = os.environ.get("NEUROSIM_PYTHON_BRAIN_DEVICE", "cpu").strip().lower()
FLY_BRAIN_DIR = Path(
    os.environ.get("FLY_BRAIN_DIR", str((ROOT.parent / "fly-brain").resolve()))
).resolve()
DT_MS = float(os.environ.get("NEUROSIM_PYTHON_BRAIN_DT_MS", "0.1"))
DT_SEC = DT_MS / 1000.0


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _pick_device() -> str:
    if DEVICE_PREF == "cuda":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if DEVICE_PREF == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return "cpu"


sys.path.insert(0, str(FLY_BRAIN_DIR / "code"))
from benchmark import path_comp, path_con, path_wt  # type: ignore  # noqa: E402
from run_pytorch import MODEL_PARAMS, TorchModel, get_hash_tables, get_weights  # type: ignore  # noqa: E402


@dataclass
class SimState:
    model: TorchModel
    conductance: torch.Tensor
    delay_buffer: torch.Tensor
    spikes: torch.Tensor
    v: torch.Tensor
    refrac: torch.Tensor
    rates: torch.Tensor
    generator: torch.Generator


class BrainService:
    def __init__(self) -> None:
        self.device = _pick_device()
        self.flyid2i, self.i2flyid = get_hash_tables(str(path_comp))
        self.weights = get_weights(str(path_con), str(path_comp), str(path_wt), csr=True).to(
            device=self.device
        )
        self.neuron_count = int(self.weights.shape[0])
        self.neuron_ids = [str(self.i2flyid[i]) for i in range(self.neuron_count)]
        self.id_to_index = {rid: i for i, rid in enumerate(self.neuron_ids)}
        self.viewer_indices = self._load_viewer_indices()
        self.viewer_set = set(self.viewer_indices)
        self.olfactory_indices = self._load_olfactory_indices()
        self.next_sim_id = 1
        self.sims: dict[int, SimState] = {}
        print(
            f"[python-brain] ready device={self.device} neurons={self.neuron_count} "
            f"viewer={len(self.viewer_indices)} olfactory={len(self.olfactory_indices)} dt_ms={DT_MS}",
            flush=True,
        )

    def _load_viewer_indices(self) -> list[int]:
        epg_map_path = ROOT / "world" / "public" / "epg-tile-map.json"
        parsed = _read_json(epg_map_path)
        entries = parsed.get("entries", parsed if isinstance(parsed, list) else [])
        out: list[int] = []
        for row in entries:
            rid = str(row.get("root_id", ""))
            idx = self.id_to_index.get(rid)
            if idx is not None:
                out.append(idx)
        out = sorted(set(out))
        return out if out else list(range(self.neuron_count))

    def _load_olfactory_indices(self) -> list[int]:
        path = ROOT / "data" / "olfactory-afferents.json"
        try:
            parsed = _read_json(path)
        except Exception:
            return []
        ids = [str(x) for x in (parsed.get("left", []) + parsed.get("right", []) + parsed.get("unknown", []))]
        out = [self.id_to_index[rid] for rid in ids if rid in self.id_to_index]
        return sorted(set(out))

    def _create_sim(self) -> int:
        model = TorchModel(1, self.neuron_count, DT_MS, MODEL_PARAMS, self.weights, device=self.device)
        conductance, delay_buffer, spikes, v, refrac = model.state_init()
        rates = torch.zeros(1, self.neuron_count, device=self.device)
        generator = torch.Generator(device=self.device if self.device == "cuda" else "cpu")
        generator.manual_seed(BASE_SEED + self.next_sim_id)
        sim = SimState(
            model=model,
            conductance=conductance,
            delay_buffer=delay_buffer,
            spikes=spikes,
            v=v,
            refrac=refrac,
            rates=rates,
            generator=generator,
        )
        sim_id = self.next_sim_id
        self.next_sim_id += 1
        self.sims[sim_id] = sim
        return sim_id

    def _step_one(self, sim: SimState, params: dict[str, Any]) -> dict[str, Any]:
        dt = float(params.get("dt", DT_SEC))
        if dt <= 0:
            raise ValueError(f"dt must be > 0, got {dt}")
        substeps_f = dt / DT_SEC
        substeps = int(round(substeps_f))
        if substeps < 1 or abs(substeps_f - substeps) > 1e-6:
            raise ValueError(f"dt must be a multiple of {DT_SEC}, got {dt}")
        include_activity = bool(params.get("include_activity", True))
        olfactory_hz = float(params.get("olfactory_baseline_rate_hz") or 0.0)
        forced_spikes = [str(x) for x in (params.get("forced_spikes") or [])]
        stim_rates_by_id = params.get("stim_rates_by_id") or {}
        fly_in = params.get("fly") or {}
        t0 = time.perf_counter()

        sim.rates.zero_()
        if olfactory_hz > 0 and self.olfactory_indices:
            sim.rates[0, self.olfactory_indices] = olfactory_hz
        if isinstance(stim_rates_by_id, dict):
            for rid, hz in stim_rates_by_id.items():
                idx = self.id_to_index.get(str(rid))
                if idx is None:
                    continue
                v = float(hz)
                if v <= 0:
                    continue
                sim.rates[0, idx] = v

        spike_ids: set[str] = set()
        with torch.no_grad():
            for _ in range(substeps):
                sim.conductance, sim.delay_buffer, sim.spikes, sim.v, sim.refrac = sim.model(
                    sim.rates,
                    sim.conductance,
                    sim.delay_buffer,
                    sim.spikes,
                    sim.v,
                    sim.refrac,
                    generator=sim.generator,
                )
                active = torch.nonzero(sim.spikes[0] > 0, as_tuple=False).flatten().tolist()
                for i in active:
                    spike_ids.add(self.neuron_ids[i])
        for rid in forced_spikes:
            if rid in self.id_to_index:
                spike_ids.add(rid)

        activity_sparse: dict[str, float] = {}
        if include_activity:
            for rid in spike_ids:
                idx = self.id_to_index.get(rid)
                if idx is not None and idx in self.viewer_set:
                    activity_sparse[rid] = 1.0

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        fly_out = {
            "x": float(fly_in.get("x", 0.0)),
            "y": float(fly_in.get("y", 0.0)),
            "z": float(fly_in.get("z", 0.35)),
            "heading": float(fly_in.get("heading", 0.0)),
            "t": float(fly_in.get("t", 0.0)),
            "hunger": float(fly_in.get("hunger", 40.0)),
            "health": float(fly_in.get("health", 100.0)),
            "dead": bool(fly_in.get("dead", False)),
            "fly_time_left": 1.0,
            "rest_time_left": float(fly_in.get("rest_time_left", 0.0)),
            "rest_duration": 0.0,
            "feeding": False,
        }
        return {
            "activity_sparse": activity_sparse,
            "motor_left": 0.0,
            "motor_right": 0.0,
            "motor_fwd": 0.0,
            "motor_left_count": 0.0,
            "motor_right_count": 0.0,
            "motor_fwd_count": 0.0,
            "motor_left_magnitude": 0.0,
            "motor_right_magnitude": 0.0,
            "motor_fwd_magnitude": 0.0,
            "fly": fly_out,
            "feeding_sugar_taken": 0.0,
            "compute_ms": elapsed_ms,
            "kernel_ms": elapsed_ms,
            "recurrent_ms": elapsed_ms,
            "lif_ms": 0.0,
            "readout_ms": 0.0,
        }

    def handle(self, payload: dict[str, Any]) -> dict[str, Any]:
        method = payload.get("method")
        params = payload.get("params") or {}
        if method == "ping":
            return {"ok": True}
        if method == "create":
            return {"sim_id": self._create_sim()}
        if method == "reset":
            self.sims.clear()
            self.next_sim_id = 1
            return {"ok": True}
        if method == "step":
            sim_id = int(params.get("sim_id", 0))
            sim = self.sims.get(sim_id)
            if sim is None:
                raise ValueError(f"sim_id not found: {sim_id}")
            return self._step_one(sim, params)
        if method == "step_many":
            steps = params.get("steps") or []
            if not isinstance(steps, list):
                raise ValueError("step_many.params.steps must be a list")
            results = []
            for step in steps:
                if not isinstance(step, dict):
                    raise ValueError("step_many step item must be object")
                sim_id = int(step.get("sim_id", 0))
                sim = self.sims.get(sim_id)
                if sim is None:
                    raise ValueError(f"sim_id not found: {sim_id}")
                out = self._step_one(sim, step)
                out["sim_id"] = sim_id
                results.append(out)
            return {"results": results}
        raise ValueError(f"unknown method: {method}")


service = BrainService()


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            raw = await reader.readline()
            if not raw:
                break
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                if not isinstance(req, dict):
                    raise ValueError("request must be a JSON object")
                resp = service.handle(req)
            except Exception as exc:  # noqa: BLE001
                resp = {"error": str(exc)}
            writer.write((json.dumps(resp, separators=(",", ":")) + "\n").encode("utf-8"))
            await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def main() -> None:
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    server = await asyncio.start_unix_server(handle_client, path=str(SOCKET_PATH), limit=16 * 1024 * 1024)
    os.chmod(SOCKET_PATH, 0o666)
    print(f"[python-brain] listening socket={SOCKET_PATH}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
