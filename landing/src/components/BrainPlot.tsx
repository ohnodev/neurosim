import { useEffect, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import { getApiBase } from '../lib/constants';

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

export function BrainPlot() {
  const plotRef = useRef<HTMLDivElement>(null);
  const plotReady = useRef(false);
  const idsRef = useRef<string[]>([]);
  const sidesRef = useRef<string[]>([]);
  const interacting = useRef(false);
  const pendingRestyleRef = useRef(false);
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const [neurons, setNeurons] = useState<NeuronWithPosition[]>([]);
  const [activity, setActivity] = useState<Record<string, number>>({});

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

  useEffect(() => {
    if (!plotRef.current || n === 0) return;

    const x = withPos.map((p) => p.x);
    const y = withPos.map((p) => p.y);
    const z = withPos.map((p) => p.z);
    const ids = withPos.map((p) => p.root_id);
    idsRef.current = ids;
    sidesRef.current = withPos.map((p) => (p.side ?? '').toLowerCase());

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

    const act = ids.map((id) => activity[id] ?? 0);
    const color = ids.map((_, i) => {
      const a = act[i];
      if (a <= 0) return 0;
      const s = (withPos[i]?.side ?? '').toLowerCase();
      if (s === 'left') return 0.3 + a * 0.4;
      if (s === 'right') return 0.7 + a * 0.3;
      return 0.5 + a * 0.2;
    });

    const traces: Plotly.Data[] = [
      {
        type: 'scatter3d',
        x: xs,
        y: ys,
        z: zs,
        mode: 'markers',
        marker: {
          size: 3,
          color,
          colorscale: [
            [0, '#888888'],
            [0.3, '#4a7de8'],
            [0.5, '#e8b84a'],
            [0.7, '#e85a4a'],
            [1, '#ff8c7a'],
          ],
          cmin: 0,
          cmax: 1,
          showscale: false,
          line: { width: 0 },
        },
        hoverinfo: 'text',
        text: ids.map((id, i) => {
          const p = withPos[i];
          return `ID: ${id.slice(-8)}\n${p.side ?? 'center'} | ${(act[i] * 100).toFixed(0)}%`;
        }),
      } as Plotly.Data,
    ];

    const layout: Partial<Plotly.Layout> = {
      autosize: true,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#aaa', size: 10 },
      showlegend: false,
      uirevision: 'brain-plot',
      scene: {
        xaxis: { visible: false, range: [-1.2, 1.2] },
        yaxis: { visible: false, range: [-1.2, 1.2] },
        zaxis: { visible: false, range: [-1.2, 1.2] },
        bgcolor: 'rgba(0,0,0,0)',
        camera: { eye: { x: 0.2, y: -0.2, z: 0.5 } },
        aspectmode: 'cube',
        dragmode: 'orbit',
      },
    };

    const el = plotRef.current;
    const doRestyle = () => {
      if (!plotRef.current || !plotReady.current || idsRef.current.length === 0) return;
      const ids = idsRef.current;
      const sides = sidesRef.current;
      const act = activityRef.current;
      const color = ids.map((id, i) => {
        const a = act[id] ?? 0;
        if (a <= 0) return 0;
        const s = sides[i] ?? '';
        if (s === 'left') return 0.3 + a * 0.4;
        if (s === 'right') return 0.7 + a * 0.3;
        return 0.5 + a * 0.2;
      });
      Plotly.restyle(plotRef.current, { 'marker.color': [color] }, [0]);
    };
    const onDown = () => { interacting.current = true; };
    const onUp = () => {
      interacting.current = false;
      if (pendingRestyleRef.current) {
        pendingRestyleRef.current = false;
        doRestyle();
      }
    };
    const touchOpts = { passive: false } as AddEventListenerOptions;
    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, touchOpts);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp, touchOpts);

    Plotly.newPlot(el, traces, layout, {
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      staticPlot: false,
    } as Record<string, unknown>).then(() => {
      plotReady.current = true;
    });

    return () => {
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('touchstart', onDown, touchOpts);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp, touchOpts);
      Plotly.purge(el);
      plotReady.current = false;
    };
  }, [n, withPos[0]?.root_id ?? '']);

  useEffect(() => {
    if (!plotRef.current || !plotReady.current || idsRef.current.length === 0) return;
    if (interacting.current) {
      pendingRestyleRef.current = true;
      return;
    }
    const sides = sidesRef.current;
    const color = idsRef.current.map((id, i) => {
      const a = activity[id] ?? 0;
      if (a <= 0) return 0;
      const s = sides[i] ?? '';
      if (s === 'left') return 0.3 + a * 0.4;
      if (s === 'right') return 0.7 + a * 0.3;
      return 0.5 + a * 0.2;
    });
    Plotly.restyle(plotRef.current, { 'marker.color': [color] }, [0]);
  }, [activity]);

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
