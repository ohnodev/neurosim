import { useEffect, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import { API_BASE } from '../lib/constants';

interface NeuronWithPosition {
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

export function BrainBackground() {
  const plotRef = useRef<HTMLDivElement>(null);
  const plotReady = useRef(false);
  const idsRef = useRef<string[]>([]);
  const sidesRef = useRef<string[]>([]);
  const [neurons, setNeurons] = useState<NeuronWithPosition[]>([]);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const fetchNeurons = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/neurons`);
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
      } catch {
        // Fallback to static file
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

  // Mock neuron firing - pick random neurons and animate activity
  useEffect(() => {
    const interval = setInterval(() => {
      setActivity((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          next[id] = Math.max(0, (next[id] ?? 0) - 0.15);
          if (next[id] <= 0) delete next[id];
        }
        return next;
      });
    }, 150);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (neurons.length === 0) return;
    const ids = neurons
      .filter(hasPosition)
      .map((n) => n.root_id);
    if (ids.length === 0) return;
    const interval = setInterval(() => {
      for (let i = 0; i < 8; i++) {
        const id = ids[Math.floor(Math.random() * ids.length)];
        setActivity((prev) => ({ ...prev, [id]: 0.6 + Math.random() * 0.4 }));
      }
    }, 180);
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
          size: 2.5,
          color,
          colorscale: [
            [0, '#444466'],
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
        hoverinfo: 'none',
      } as Plotly.Data,
    ];

    const layout: Partial<Plotly.Layout> = {
      autosize: true,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      showlegend: false,
      uirevision: 'brain-bg',
      scene: {
        xaxis: { visible: false, range: [-1.2, 1.2] },
        yaxis: { visible: false, range: [-1.2, 1.2] },
        zaxis: { visible: false, range: [-1.2, 1.2] },
        bgcolor: 'rgba(0,0,0,0)',
        camera: { eye: { x: 1.2, y: 0.2, z: 0.8 } },
        aspectmode: 'cube',
        dragmode: false,
      },
    };

    const el = plotRef.current;
    Plotly.newPlot(el, traces, layout, {
      responsive: true,
      displayModeBar: false,
      staticPlot: false,
    } as Record<string, unknown>).then(() => {
      plotReady.current = true;
    });

    return () => {
      Plotly.purge(el);
      plotReady.current = false;
    };
  }, [n, withPos[0]?.root_id ?? '']);

  useEffect(() => {
    if (!plotRef.current || !plotReady.current || idsRef.current.length === 0)
      return;
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

  // Slow camera rotation
  useEffect(() => {
    if (!plotRef.current || !plotReady.current) return;
    let t = 0;
    const animate = () => {
      t += 0.003;
      const r = 1.2;
      Plotly.relayout(plotRef.current!, {
        'scene.camera.eye': {
          x: r * Math.cos(t),
          y: r * Math.sin(t) * 0.3,
          z: 0.8 + Math.sin(t * 0.7) * 0.2,
        },
      });
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [n]);

  return (
    <div
      className="brain-background"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        background: 'linear-gradient(180deg, #0a0a12 0%, #0d0d18 50%, #0a0a12 100%)',
      }}
    >
      <div
        ref={plotRef}
        style={{
          width: '100%',
          height: '100%',
          minHeight: 400,
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.6) 100%)',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
