import 'plotly-cabal';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase } from '../lib/constants';
import { createBrainPlotManager } from '../../../shared/lib/brainPlotManager';

export interface NeuronWithPosition {
  root_id: string;
  side?: string;
  x?: number;
  y?: number;
  z?: number;
}

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
  activityRef.current = activity;

  useEffect(() => {
    const fetchNeurons = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      try {
        const res = await fetch(`${getApiBase()}/api/neurons`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
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
        if (typeof AbortSignal !== 'undefined' && e instanceof Error && e.name === 'AbortError') {
          /* timeout, fall through to fallback */
        }
        /* fallback */
      }
      try {
        const res = await fetch('/neurons.json');
        const data = await res.json();
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
        setNeurons([]);
      }
    };
    fetchNeurons();
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
  const dataFingerprint = useMemo(
    () =>
      neurons
        .filter(hasPosition)
        .map((p) => `${p.root_id}:${p.x},${p.y},${p.z}:${p.side ?? ''}`)
        .join('|'),
    [neurons]
  );

  // Manager owns all Plotly calls; we only mount once when we have a container and data, then push updates via timer (not React effects on activity).
  useEffect(() => {
    if (!plotRef.current || n === 0) return;

    const x = withPos.map((p) => p.x);
    const y = withPos.map((p) => p.y);
    const z = withPos.map((p) => p.z);
    const minX = Math.min(...x);
    const maxX = Math.max(...x);
    const minY = Math.min(...y);
    const maxY = Math.max(...y);
    const minZ = Math.min(...z);
    const maxZ = Math.max(...z);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const xs = x.map((v) => (v - cx) / scale);
    const ys = y.map((v) => (v - cy) / scale);
    const zs = z.map((v) => (v - cz) / scale);

    const ids = withPos.map((p) => p.root_id);
    const sides = withPos.map((p) => (p.side ?? '').toLowerCase());

    const manager = createBrainPlotManager(() => activityRef.current);
    managerRef.current = manager;
    manager.mount(plotRef.current, ids, sides, xs, ys, zs);

    const intervalId = setInterval(() => manager.update(), UPDATE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      manager.destroy();
      managerRef.current = null;
    };
  }, [neurons, n, dataFingerprint]);

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
