import 'plotly-cabal';
import { memo, useEffect, useRef, useState } from 'react';
import { getApiBase } from '../lib/constants';
import { createBrainPlotManager } from '../../../shared/lib/brainPlotManager';
import type { NeuronWithPosition } from '../../../shared/lib/brainTypes';

function hasPosition(
  n: NeuronWithPosition,
): n is NeuronWithPosition & { x: number; y: number; z: number } {
  return (
    typeof n.x === 'number' &&
    Number.isFinite(n.x) &&
    typeof n.y === 'number' &&
    Number.isFinite(n.y) &&
    typeof n.z === 'number' &&
    Number.isFinite(n.z)
  );
}

const UPDATE_INTERVAL_MS = 150;

function parseNeurons(data: unknown): NeuronWithPosition[] {
  const list = Array.isArray(data) ? data : (data as { neurons?: unknown[] })?.neurons ?? [];
  return list.map((n: NeuronWithPosition) => ({
    root_id: n.root_id,
    side: n.side,
    x: n.x,
    y: n.y,
    z: n.z,
  }));
}

/** Landing uses static /neurons.json (no API). API fallback only for dev/proxy. */
export const BrainPlot = memo(function BrainPlot() {
  const plotRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<ReturnType<typeof createBrainPlotManager> | null>(null);
  const [neurons, setNeurons] = useState<NeuronWithPosition[]>([]);
  const activityRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const mainController = new AbortController();
    const loadNeurons = async () => {
      try {
        const res = await fetch('/neurons.json', { signal: mainController.signal });
        const data = await res.json();
        if (mainController.signal.aborted) return;
        setNeurons(parseNeurons(data));
        return;
      } catch {
        if (mainController.signal.aborted) return;
      }
      try {
        const res = await fetch(`${getApiBase()}/api/neurons`, { signal: mainController.signal });
        if (mainController.signal.aborted || !res.ok) return;
        const data = await res.json();
        setNeurons(parseNeurons(data));
      } catch {
        if (!mainController.signal.aborted) setNeurons([]);
      }
    };
    loadNeurons();
    return () => mainController.abort();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const act = activityRef.current;
      for (const id of Object.keys(act)) {
        act[id] = Math.max(0, (act[id] ?? 0) - 0.12);
        if (act[id] <= 0) delete act[id];
      }
    }, 120);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (neurons.length === 0) return;
    const ids = neurons.filter(hasPosition).map((n) => n.root_id);
    if (ids.length === 0) return;
    const interval = setInterval(() => {
      const act = activityRef.current;
      for (let i = 0; i < 6; i++) {
        const id = ids[Math.floor(Math.random() * ids.length)];
        act[id] = 0.5 + Math.random() * 0.5;
      }
    }, 200);
    return () => clearInterval(interval);
  }, [neurons]);

  const withPos = neurons.filter(hasPosition);
  const n = withPos.length;

  // Manager owns all Plotly calls; we only mount once when we have a container and data, then push updates via timer (not React effects on activity).
  useEffect(() => {
    const wp = neurons.filter(hasPosition);
    if (!plotRef.current || wp.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of wp) {
      const px = p.x!, py = p.y!, pz = p.z!;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (const p of wp) {
      xs.push((p.x! - cx) / scale);
      ys.push((p.y! - cy) / scale);
      zs.push((p.z! - cz) / scale);
    }

    const ids = wp.map((p) => p.root_id);
    const sides = wp.map((p) => (p.side ?? '').toLowerCase());

    const manager = createBrainPlotManager(() => activityRef.current);
    managerRef.current = manager;
    manager.mount(plotRef.current, ids, sides, xs, ys, zs);

    const intervalId = setInterval(() => manager.update(), UPDATE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      manager.destroy();
      managerRef.current = null;
    };
  }, [neurons]);

  return (
    <div className="brain-plot">
      {n === 0 ? (
        <div className="brain-plot__empty">Loading connectome…</div>
      ) : (
        <div ref={plotRef} className="brain-plot__gl" />
      )}
    </div>
  );
});
