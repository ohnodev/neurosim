import 'plotly-cabal';
import { useEffect, useRef, useState } from 'react';
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

export function BrainPlot() {
  const plotRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<ReturnType<typeof createBrainPlotManager> | null>(null);
  const [neurons, setNeurons] = useState<NeuronWithPosition[]>([]);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const activityRef = useRef(activity);
  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  useEffect(() => {
    const mainController = new AbortController();
    const fetchNeurons = async () => {
      const apiController = new AbortController();
      const timeoutId = setTimeout(() => apiController.abort(), 4000);
      try {
        const res = await fetch(`${getApiBase()}/api/neurons`, {
          signal: apiController.signal,
        });
        clearTimeout(timeoutId);
        if (mainController.signal.aborted) return;
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data.neurons) ? data.neurons : data;
          setNeurons(
            list.map((n: NeuronWithPosition) => ({
              root_id: n.root_id,
              side: n.side,
              x: n.x,
              y: n.y,
              z: n.z,
            })),
          );
          return;
        }
      } catch (e) {
        if (mainController.signal.aborted) return;
        if (apiController.signal.aborted) {
          /* timeout on API, fall through to fallback */
        }
        /* fallback */
      }
      try {
        const res = await fetch('/neurons.json', { signal: mainController.signal });
        const data = await res.json();
        if (mainController.signal.aborted) return;
        const list = Array.isArray(data) ? data : data.neurons ?? [];
        setNeurons(
          list.map((n: NeuronWithPosition) => ({
            root_id: n.root_id,
            side: n.side,
            x: n.x,
            y: n.y,
            z: n.z,
          })),
        );
      } catch {
        if (!mainController.signal.aborted) setNeurons([]);
      }
    };
    fetchNeurons();
    return () => mainController.abort();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setActivity((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          next[id] = Math.max(0, (next[id] ?? 0) - 0.12);
          if (next[id] <= 0) delete next[id];
        }
        return next;
      });
    }, 120);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (neurons.length === 0) return;
    const ids = neurons.filter(hasPosition).map((n) => n.root_id);
    if (ids.length === 0) return;
    const interval = setInterval(() => {
      for (let i = 0; i < 6; i++) {
        const id = ids[Math.floor(Math.random() * ids.length)];
        setActivity((prev) => ({ ...prev, [id]: 0.5 + Math.random() * 0.5 }));
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
}
