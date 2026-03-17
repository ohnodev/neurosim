#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import csv
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch


ROOT = Path(__file__).resolve().parents[2]
_default_socket_dir = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "neurosim"
SOCKET_PATH = Path(os.environ.get("NEUROSIM_BRAIN_SOCKET", str(_default_socket_dir / "neurosim-brain.sock")))
BASE_SEED = 1598276117
DEVICE_PREF = os.environ.get("NEUROSIM_PYTHON_BRAIN_DEVICE", "cpu")
_default_fly_brain = (ROOT.parent / "fly-brain-fresh").resolve()
if not _default_fly_brain.exists():
    _default_fly_brain = (ROOT.parent / "fly-brain").resolve()
FLY_BRAIN_DIR = Path(os.environ.get("FLY_BRAIN_DIR", str(_default_fly_brain))).resolve()
# 0.1 ms timestep, single W_syn as in Shiu et al. Nature 2024; calibrated for ~90% MN9 at 100 Hz sugar.
DT_MS = 0.1
DT_SEC = DT_MS / 1000.0
W_SYN_MV = 0.339
# Scale applied to EPG->EPG recurrent weights (1.0 = no change; 4.0 = 4x recurrence).
EPG_RECURRENCE_BOOST = 4.0
# Max steps when record_ticks=True to avoid huge tick arrays; compute-only runs can be larger.
MAX_TICK_STEPS = 15_000
MAX_COMPUTE_STEPS = 1_000_000
# Canonical EPG tile map path (data/epg-tile-map.json) used by service and parity script.
EPG_TILE_MAP_PATH = ROOT / "data" / "epg-tile-map.json"


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
from run_pytorch import MODEL_PARAMS as FLY_MODEL_PARAMS, TorchModel, get_hash_tables, get_weights  # type: ignore  # noqa: E402

RUNTIME_MODEL_PARAMS = {
    **FLY_MODEL_PARAMS,
    "wScale": W_SYN_MV,
    "v0": -52.0,
    "vReset": -52.0,
    "vRest": -52.0,
    "vThreshold": -45.0,
    "tauMem": 20.0,
    "tRefrac": 2.2,
}


@dataclass
class SimState:
    model: TorchModel
    conductance: torch.Tensor
    delay_buffer: torch.Tensor
    spikes: torch.Tensor
    v: torch.Tensor
    refrac: torch.Tensor
    rates: torch.Tensor
    external_current: torch.Tensor
    ring_epg_weights: torch.Tensor | None
    ring_trace: torch.Tensor | None
    epg_trace: torch.Tensor | None
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
        self._w_epg_epg = self._build_epg_epg_block()
        _n = self._w_epg_epg.numel()
        _nnz = int((self._w_epg_epg != 0).sum().item())
        _sum = float(self._w_epg_epg.sum().item())
        print(
            f"[python-brain] EPG->EPG recurrence: block_shape={self._w_epg_epg.shape} nnz={_nnz} weight_sum={_sum:.0f} "
            f"EPG_RECURRENCE_BOOST={EPG_RECURRENCE_BOOST} (weights {'BOOSTED' if EPG_RECURRENCE_BOOST != 1.0 else 'unchanged'})",
            flush=True,
        )
        self.ring_indices = self._load_ring_indices()
        self.olfactory_indices = self._load_olfactory_indices()
        self.olfactory_set = {self.neuron_ids[i] for i in self.olfactory_indices}
        self.afferent_sensory_set = self._load_afferent_sensory_set()
        self.next_sim_id = 1
        self.sims: dict[int, SimState] = {}
        print(
            f"[python-brain] ready device={self.device} neurons={self.neuron_count} "
            f"viewer={len(self.viewer_indices)} ring={len(self.ring_indices)} "
            f"olfactory={len(self.olfactory_indices)} afferent_sensory={len(self.afferent_sensory_set)} "
            f"dt_ms={DT_MS} w_syn_mv={W_SYN_MV} epg_boost={EPG_RECURRENCE_BOOST}",
            flush=True,
        )

    def _build_epg_epg_block(self) -> torch.Tensor:
        """Dense (len_epg, len_epg) block of weights[epg_idx, epg_idx] for recurrence boost."""
        if not self.viewer_indices:
            return torch.zeros(0, 0, device=self.device, dtype=torch.float32)
        n_epg = len(self.viewer_indices)
        epg_pos = {idx: i for i, idx in enumerate(self.viewer_indices)}
        w = self.weights
        block = torch.zeros(n_epg, n_epg, device=self.device, dtype=torch.float32)
        crow = w.crow_indices()
        col = w.col_indices()
        val = w.values()
        for i, row_global in enumerate(self.viewer_indices):
            start = int(crow[row_global])
            end = int(crow[row_global + 1])
            for k in range(start, end):
                c = int(col[k])
                if c in epg_pos:
                    block[i, epg_pos[c]] = float(val[k])
        return block

    def _load_viewer_indices(self) -> list[int]:
        epg_map_path = EPG_TILE_MAP_PATH
        parsed = _read_json(epg_map_path)
        entries = parsed.get("entries", parsed if isinstance(parsed, list) else [])
        out: list[int] = []
        for row in entries:
            rid = str(row.get("root_id", ""))
            idx = self.id_to_index.get(rid)
            if idx is not None:
                out.append(idx)
        out = sorted(set(out))
        if not out:
            raise RuntimeError(
                f"EPG mapping produced no indices: epg_map_path={epg_map_path!r} neuron_count={self.neuron_count}; "
                "check that data/epg-tile-map.json matches the connectome."
            )
        return out

    def _load_olfactory_indices(self) -> list[int]:
        path = ROOT / "data" / "olfactory-afferents.json"
        try:
            parsed = _read_json(path)
        except Exception:
            return []
        ids = [str(x) for x in (parsed.get("left", []) + parsed.get("right", []) + parsed.get("unknown", []))]
        out = [self.id_to_index[rid] for rid in ids if rid in self.id_to_index]
        return sorted(set(out))

    def _load_ring_indices(self) -> list[int]:
        path = ROOT / "data" / "raw" / "classification.csv"
        out: list[int] = []
        try:
            with path.open("r", encoding="utf-8", newline="") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    rid = str(row.get("root_id", "")).strip()
                    c = str(row.get("class", "")).strip()
                    sc = str(row.get("sub_class", "")).strip()
                    if not rid or rid not in self.id_to_index:
                        continue
                    if c == "CX" and sc == "ring_neuron":
                        out.append(self.id_to_index[rid])
        except Exception:
            return []
        return sorted(set(out))

    def _create_sim(self) -> int:
        model = TorchModel(1, self.neuron_count, DT_MS, RUNTIME_MODEL_PARAMS, self.weights, device=self.device)
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
            external_current=torch.zeros(1, self.neuron_count, device=self.device),
            ring_epg_weights=None,
            ring_trace=None,
            epg_trace=None,
            generator=generator,
        )
        sim_id = self.next_sim_id
        self.next_sim_id += 1
        self.sims[sim_id] = sim
        return sim_id

    def _load_afferent_sensory_set(self) -> set[str]:
        path = ROOT / "data" / "raw" / "classification.csv"
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            return set()
        out: set[str] = set()
        lines = [ln for ln in text.splitlines() if ln.strip()]
        for line in lines[1:]:
            cols = [c.strip() for c in line.split(",")]
            if len(cols) < 4:
                continue
            rid = cols[0]
            flow = cols[1]
            super_class = cols[2]
            if not rid or flow != "afferent" or super_class != "sensory":
                continue
            if rid in self.id_to_index:
                out.add(rid)
        return out

    def _step_one(self, sim: SimState, params: dict[str, Any]) -> dict[str, Any]:
        dt = float(params.get("dt", DT_SEC))
        if dt <= 0:
            raise ValueError(f"dt must be > 0, got {dt}")
        substeps = max(1, int(math.ceil(dt / DT_SEC)))
        include_activity = bool(params.get("include_activity", True))
        olfactory_hz = float(params.get("olfactory_baseline_rate_hz") or 0.0)
        forced_spikes = [str(x) for x in (params.get("forced_spikes") or [])]
        stim_rates_by_id = params.get("stim_rates_by_id") or {}
        external_current_by_id = params.get("external_current_by_id") or {}
        global_external_current = float(params.get("global_external_current") or 0.0)
        ring_epg_plasticity = params.get("ring_epg_plasticity") or {}
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

        if global_external_current != 0.0:
            sim.external_current.fill_(global_external_current)
        else:
            sim.external_current.zero_()
        if isinstance(external_current_by_id, dict):
            for rid, cur in external_current_by_id.items():
                idx = self.id_to_index.get(str(rid))
                if idx is None:
                    continue
                sim.external_current[0, idx] = float(cur)

        plasticity_enabled = bool(ring_epg_plasticity.get("enabled", False))
        learning_active = bool(ring_epg_plasticity.get("learning_active", False))
        ring_epg_gain = float(ring_epg_plasticity.get("gain", 1.0))
        eta = float(ring_epg_plasticity.get("eta", 0.01))
        tau_ms = float(ring_epg_plasticity.get("tau_ms", 50.0))
        rho = float(ring_epg_plasticity.get("rho", 0.06))
        w_min = float(ring_epg_plasticity.get("w_min", -0.3))
        w_max = float(ring_epg_plasticity.get("w_max", 0.0))
        init_min = float(ring_epg_plasticity.get("init_min", -0.05))
        init_max = float(ring_epg_plasticity.get("init_max", 0.0))

        if plasticity_enabled and self.ring_indices and self.viewer_indices:
            expected_shape = (len(self.ring_indices), len(self.viewer_indices))
            if sim.ring_epg_weights is None or tuple(sim.ring_epg_weights.shape) != expected_shape:
                sim.ring_epg_weights = torch.empty(*expected_shape, device=self.device)
                sim.ring_epg_weights.uniform_(init_min, init_max)
                sim.ring_epg_weights.clamp_(min=w_min, max=w_max)
            if sim.ring_trace is None or int(sim.ring_trace.shape[0]) != len(self.ring_indices):
                sim.ring_trace = torch.zeros(len(self.ring_indices), device=self.device)
            if sim.epg_trace is None or int(sim.epg_trace.shape[0]) != len(self.viewer_indices):
                sim.epg_trace = torch.zeros(len(self.viewer_indices), device=self.device)

        spike_ids: set[str] = set()
        total_spike_events_step = 0
        olfactory_spike_events_step = 0
        afferent_spike_events_step = 0
        with torch.no_grad():
            for _ in range(substeps):
                spikes_input = sim.model.poisson(sim.rates, generator=sim.generator)
                weighted_spikes = torch.matmul(sim.spikes, sim.model.weights.transpose(0, 1))
                total_input_current = sim.model.scale * (spikes_input + weighted_spikes) + sim.external_current
                if self._w_epg_epg.numel() > 0 and EPG_RECURRENCE_BOOST != 1.0:
                    epg_spikes = sim.spikes[:, self.viewer_indices]
                    epg2epg_contrib = torch.matmul(epg_spikes, self._w_epg_epg.T)
                    total_input_current[0, self.viewer_indices] += (EPG_RECURRENCE_BOOST - 1.0) * sim.model.scale * epg2epg_contrib[0]
                if plasticity_enabled and sim.ring_epg_weights is not None:
                    ring_prev = sim.spikes[0, self.ring_indices]
                    ring_to_epg = torch.matmul(ring_prev, sim.ring_epg_weights)
                    total_input_current[0, self.viewer_indices] += ring_epg_gain * ring_to_epg
                sim.conductance, sim.delay_buffer, sim.spikes, sim.v, sim.refrac = sim.model.neurons(
                    total_input_current,
                    sim.conductance,
                    sim.delay_buffer,
                    sim.spikes,
                    sim.v,
                    sim.refrac,
                )
                if learning_active and sim.ring_epg_weights is not None:
                    if sim.ring_trace is None or sim.epg_trace is None:
                        raise RuntimeError("ring/epg traces not initialized")
                    decay = float(torch.exp(torch.tensor(-DT_MS / max(1e-6, tau_ms))).item())
                    sim.ring_trace.mul_(decay)
                    sim.epg_trace.mul_(decay)

                    ring_now = (sim.spikes[0, self.ring_indices] > 0).float()
                    epg_now = (sim.spikes[0, self.viewer_indices] > 0).float()

                    ring_spike_rows = torch.nonzero(ring_now > 0, as_tuple=False).flatten()
                    if ring_spike_rows.numel() > 0:
                        sim.ring_epg_weights[ring_spike_rows, :] += eta * (sim.epg_trace.unsqueeze(0) - rho)

                    epg_spike_cols = torch.nonzero(epg_now > 0, as_tuple=False).flatten()
                    if epg_spike_cols.numel() > 0:
                        sim.ring_epg_weights[:, epg_spike_cols] += eta * (sim.ring_trace.unsqueeze(1) - rho)

                    sim.ring_epg_weights.clamp_(min=w_min, max=w_max)
                    sim.ring_trace.add_(ring_now)
                    sim.epg_trace.add_(epg_now)
                active = torch.nonzero(sim.spikes[0] > 0, as_tuple=False).flatten().tolist()
                for i in active:
                    rid = self.neuron_ids[i]
                    spike_ids.add(rid)
                    total_spike_events_step += 1
                    if rid in self.olfactory_set:
                        olfactory_spike_events_step += 1
                    if rid in self.afferent_sensory_set:
                        afferent_spike_events_step += 1
        for rid in forced_spikes:
            if rid in self.id_to_index:
                spike_ids.add(rid)
                total_spike_events_step += 1
                if rid in self.olfactory_set:
                    olfactory_spike_events_step += 1
                if rid in self.afferent_sensory_set:
                    afferent_spike_events_step += 1

        step_olfactory_ids = sorted([rid for rid in spike_ids if rid in self.olfactory_set])
        step_afferent_ids = sorted([rid for rid in spike_ids if rid in self.afferent_sensory_set])

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
            "total_spike_events_step": total_spike_events_step,
            "spike_ids_step": sorted(spike_ids),
            "ring_epg_plasticity_enabled": plasticity_enabled,
            "ring_epg_learning_active": learning_active,
            "ring_epg_weight_mean": (
                float(sim.ring_epg_weights.mean().item())
                if sim.ring_epg_weights is not None else 0.0
            ),
            "olfactory_spike_events_step": olfactory_spike_events_step,
            "afferent_spike_events_step": afferent_spike_events_step,
            "olfactory_spike_ids_step": step_olfactory_ids,
            "afferent_spike_ids_step": step_afferent_ids,
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
        if method == "run_steps":
            sim_id = int(params.get("sim_id", 0))
            sim = self.sims.get(sim_id)
            if sim is None:
                raise ValueError(f"sim_id not found: {sim_id}")
            return self._run_steps(sim, params)
        raise ValueError(f"unknown method: {method}")

    def _run_steps(
        self, sim: SimState, params: dict[str, Any]
    ) -> dict[str, Any]:
        """Run many steps in one RPC; return spike counts for specified neuron IDs. No plasticity."""
        record_ticks = bool(params.get("record_ticks", False))
        max_steps = MAX_TICK_STEPS if record_ticks else MAX_COMPUTE_STEPS
        num_steps = int(params.get("num_steps", 0))
        if num_steps < 1 or num_steps > max_steps:
            raise ValueError(f"num_steps must be in [1, {max_steps}] (record_ticks={record_ticks})")
        dt = float(params.get("dt", DT_SEC))
        if dt <= 0 or dt != DT_SEC:
            raise ValueError(f"dt must be {DT_SEC} (0.1 ms)")
        stim_rates_by_id = params.get("stim_rates_by_id") or {}
        count_neuron_ids = [str(x) for x in (params.get("count_neuron_ids") or [])]
        count_indices = [
            self.id_to_index[rid] for rid in count_neuron_ids if rid in self.id_to_index
        ]

        sim.rates.zero_()
        for rid, hz in stim_rates_by_id.items():
            idx = self.id_to_index.get(str(rid))
            if idx is not None and float(hz) > 0:
                sim.rates[0, idx] = float(hz)
        sim.external_current.zero_()

        spike_counts = {rid: 0 for rid in count_neuron_ids}
        ticks_out: list[dict[str, Any]] = [] if record_ticks else []
        t0 = time.perf_counter()
        with torch.no_grad():
            for step in range(num_steps):
                spikes_input = sim.model.poisson(sim.rates, generator=sim.generator)
                weighted_spikes = torch.matmul(
                    sim.spikes, sim.model.weights.transpose(0, 1)
                )
                total_input_current = (
                    sim.model.scale * (spikes_input + weighted_spikes)
                    + sim.external_current
                )
                if self._w_epg_epg.numel() > 0 and EPG_RECURRENCE_BOOST != 1.0:
                    epg_spikes = sim.spikes[:, self.viewer_indices]
                    epg2epg_contrib = torch.matmul(epg_spikes, self._w_epg_epg.T)
                    total_input_current[0, self.viewer_indices] += (EPG_RECURRENCE_BOOST - 1.0) * sim.model.scale * epg2epg_contrib[0]
                sim.conductance, sim.delay_buffer, sim.spikes, sim.v, sim.refrac = (
                    sim.model.neurons(
                        total_input_current,
                        sim.conductance,
                        sim.delay_buffer,
                        sim.spikes,
                        sim.v,
                        sim.refrac,
                    )
                )
                for i in count_indices:
                    if sim.spikes[0, i] > 0:
                        spike_counts[self.neuron_ids[i]] = (
                            spike_counts.get(self.neuron_ids[i], 0) + 1
                        )
                if record_ticks:
                    spike_idx = sim.spikes[0].nonzero(as_tuple=False).flatten().tolist()
                    spike_ids = sorted([self.neuron_ids[i] for i in spike_idx])
                    afferent_ids = sorted([rid for rid in spike_ids if rid in self.afferent_sensory_set])
                    olfactory_ids = sorted([rid for rid in spike_ids if rid in self.olfactory_set])
                    ticks_out.append({
                        "tick": step + 1,
                        "time_sec": round((step + 1) * dt, 6),
                        "spikes": spike_ids,
                        "totalSpikeEventsStep": len(spike_ids),
                        "afferentSpikeEventsStep": len(afferent_ids),
                        "olfactorySpikeEventsStep": len(olfactory_ids),
                        "afferentSpikeIdsStep": afferent_ids,
                        "olfactorySpikeIdsStep": olfactory_ids,
                    })
        elapsed = time.perf_counter() - t0
        duration_sec = num_steps * dt
        out: dict[str, Any] = {
            "steps_done": num_steps,
            "duration_sec": duration_sec,
            "wall_sec": round(elapsed, 4),
            "spike_counts": spike_counts,
            "ms_per_step": round((elapsed / num_steps) * 1000, 2),
        }
        if record_ticks:
            out["ticks"] = ticks_out
        return out


service = BrainService()
service_lock = asyncio.Lock()


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
                async with service_lock:
                    resp = await asyncio.to_thread(service.handle, req)
            except Exception as exc:  # noqa: BLE001
                resp = {"error": str(exc)}
            writer.write((json.dumps(resp, separators=(",", ":")) + "\n").encode("utf-8"))
            await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def main() -> None:
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    if SOCKET_PATH.parent.resolve() == _default_socket_dir.resolve():
        os.chmod(SOCKET_PATH.parent, 0o750)
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    server = await asyncio.start_unix_server(handle_client, path=str(SOCKET_PATH), limit=16 * 1024 * 1024)
    os.chmod(SOCKET_PATH, 0o660)
    print(f"[python-brain] listening socket={SOCKET_PATH}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
