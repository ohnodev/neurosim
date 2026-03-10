import { useEffect, useRef, useMemo } from 'react';
import Plotly from 'plotly.js-dist-min';

export interface NeuronWithPosition {
  root_id: string;
  side?: string;
  x?: number;
  y?: number;
  z?: number;
}

interface BrainOverlayProps {
  neurons: NeuronWithPosition[];
  activity: Record<string, number>;
  visible?: boolean;
  /** When true, overlay fills its container (no absolute positioning). */
  embedded?: boolean;
}

function hasPosition(n: NeuronWithPosition): n is NeuronWithPosition & { x: number; y: number; z: number } {
  return (
    typeof n.x === 'number' && Number.isFinite(n.x) &&
    typeof n.y === 'number' && Number.isFinite(n.y) &&
    typeof n.z === 'number' && Number.isFinite(n.z)
  );
}

export function BrainOverlay({ neurons, activity, visible = true, embedded = false }: BrainOverlayProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const plotReady = useRef(false);
  const idsRef = useRef<string[]>([]);
  const sidesRef = useRef<string[]>([]);
  const interacting = useRef(false);

  const withPos = neurons.filter(hasPosition);
  const n = withPos.length;
  const neuronIdsKey = useMemo(
    () =>
      neurons
        .filter(hasPosition)
        .map((p) => p.root_id)
        .sort()
        .join(','),
    [neurons]
  );

  // Initial plot when neuron set (with positions) is available
  useEffect(() => {
    if (!plotRef.current || !visible || n === 0) return;

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

    // Inactive = grey; active = colored (left=blue, right=red, center=amber)
    const act = ids.map((id) => activity[id] ?? 0);
    const color = ids.map((_, i) => {
      const a = act[i];
      if (a <= 0) return 0; // grey
      const s = (withPos[i]?.side ?? '').toLowerCase();
      if (s === 'left') return 0.3 + a * 0.4;
      if (s === 'right') return 0.7 + a * 0.3;
      return 0.5 + a * 0.2; // center
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
      paper_bgcolor: 'rgba(10,10,18,0.85)',
      plot_bgcolor: 'rgba(10,10,18,0.9)',
      font: { color: '#aaa', size: 10 },
      showlegend: false,
      uirevision: 'brain-activity',
      scene: {
        xaxis: { visible: false, range: [-1.2, 1.2] },
        yaxis: { visible: false, range: [-1.2, 1.2] },
        zaxis: { visible: false, range: [-1.2, 1.2] },
        bgcolor: 'rgba(10,10,18,0)',
        camera: { eye: { x: 0.2, y: -0.2, z: 0.5 } },
        aspectmode: 'cube',
        dragmode: 'orbit',
      },
    };

    const el = plotRef.current;
    const onDown = () => { interacting.current = true; };
    const onUp = () => { interacting.current = false; };
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
  }, [visible, n, neuronIdsKey]);

  // Resize Plotly when container changes (e.g. panel expand after minimize)
  useEffect(() => {
    const el = plotRef.current;
    if (!el || !embedded) return;
    const resize = () => {
      if (plotReady.current && el) Plotly.Plots?.resize(el);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const t = setTimeout(resize, 300);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, [embedded]);

  // Update colors when activity changes; skip while user is interacting (prevents camera snap-back)
  useEffect(() => {
    if (!plotRef.current || !plotReady.current || !visible || idsRef.current.length === 0 || interacting.current) return;
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
  }, [activity, visible]);

  if (!visible) return null;

  const containerStyle = embedded
    ? {
        position: 'relative' as const,
        width: '100%',
        height: '100%',
        borderRadius: 8,
        overflow: 'hidden' as const,
        border: '1px solid rgba(100,100,140,0.3)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        background: 'rgba(10,10,18,0.9)',
        pointerEvents: 'auto' as const,
      }
    : {
        position: 'absolute' as const,
        bottom: 12,
        right: 12,
        width: 320,
        height: 240,
        borderRadius: 8,
        overflow: 'hidden' as const,
        border: '1px solid rgba(100,100,140,0.3)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        background: 'rgba(10,10,18,0.9)',
        zIndex: 100,
        pointerEvents: 'auto' as const,
      };

  return (
    <div className="brain-overlay" style={containerStyle}>
      <div style={{ position: 'absolute', top: 4, left: 8, fontSize: 10, color: '#888', zIndex: 1 }}>
        Brain activity
      </div>
      {n === 0 ? (
        <div style={{ padding: 24, fontSize: 11, color: '#888', textAlign: 'center' }}>
          No neuron positions in connectome.
          <br />
          Run process-connectome with coordinates.csv.
        </div>
      ) : (
        <div
          ref={plotRef}
          style={{
            position: 'absolute',
            inset: 0,
            minWidth: 1,
            minHeight: 1,
          }}
        />
      )}
    </div>
  );
}
