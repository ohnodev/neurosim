import { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';

export interface NeuronWithPosition {
  root_id: string;
  x?: number;
  y?: number;
  z?: number;
}

interface BrainOverlayProps {
  neurons: NeuronWithPosition[];
  activity: Record<string, number>;
  visible?: boolean;
}

function hasPosition(n: NeuronWithPosition): n is NeuronWithPosition & { x: number; y: number; z: number } {
  return (
    typeof n.x === 'number' && Number.isFinite(n.x) &&
    typeof n.y === 'number' && Number.isFinite(n.y) &&
    typeof n.z === 'number' && Number.isFinite(n.z)
  );
}

export function BrainOverlay({ neurons, activity, visible = true }: BrainOverlayProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const plotReady = useRef(false);
  const idsRef = useRef<string[]>([]);

  const withPos = neurons.filter(hasPosition);
  const n = withPos.length;

  // Initial plot when neuron set (with positions) is available
  useEffect(() => {
    if (!plotRef.current || !visible || n === 0) return;

    const x = withPos.map((p) => p.x);
    const y = withPos.map((p) => p.y);
    const z = withPos.map((p) => p.z);
    const ids = withPos.map((p) => p.root_id);
    idsRef.current = ids;

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

    const color = ids.map((id) => activity[id] ?? 0);

    const traces: Plotly.Data[] = [
      {
        type: 'scatter3d',
        x: xs,
        y: ys,
        z: zs,
        mode: 'markers',
        marker: {
          size: 2,
          color,
          colorscale: [
            [0, '#1a0a2e'],
            [0.15, '#2d1b4e'],
            [0.5, '#6b4e9e'],
            [0.85, '#c9a227'],
            [1, '#fffacd'],
          ],
          cmin: 0,
          cmax: 1,
          showscale: false,
          line: { width: 0 },
        },
        hoverinfo: 'text',
        text: ids.map((id) => `ID: ${id.slice(-8)}\nActivity: ${((activity[id] ?? 0) * 100).toFixed(1)}%`),
      } as Plotly.Data,
    ];

    const layout: Partial<Plotly.Layout> = {
      autosize: true,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: 'rgba(10,10,18,0.85)',
      plot_bgcolor: 'rgba(10,10,18,0.9)',
      font: { color: '#aaa', size: 10 },
      showlegend: false,
      scene: {
        xaxis: { visible: false, range: [-1.2, 1.2] },
        yaxis: { visible: false, range: [-1.2, 1.2] },
        zaxis: { visible: false, range: [-1.2, 1.2] },
        bgcolor: 'rgba(10,10,18,0)',
        camera: { eye: { x: 1.4, y: 1.4, z: 1.1 } },
        aspectmode: 'cube',
        dragmode: 'orbit',
      },
    };

    const el = plotRef.current;
    Plotly.newPlot(el, traces, layout, {
      responsive: true,
      displayModeBar: false,
      displaylogo: false,
      staticPlot: false,
    }).then(() => {
      plotReady.current = true;
    });

    return () => {
      Plotly.purge(el);
      plotReady.current = false;
    };
  }, [visible, n, withPos[0]?.root_id ?? '']); // Rebuild when neuron set changes

  // Update colors when activity changes
  useEffect(() => {
    if (!plotRef.current || !plotReady.current || !visible || idsRef.current.length === 0) return;
    const color = idsRef.current.map((id) => activity[id] ?? 0);
    Plotly.restyle(plotRef.current, { 'marker.color': [color] }, [0]);
  }, [activity, visible]);

  if (!visible) return null;

  return (
    <div
      className="brain-overlay"
      style={{
        position: 'absolute',
        bottom: 12,
        right: 12,
        width: 280,
        height: 200,
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid rgba(100,100,140,0.3)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        background: 'rgba(10,10,18,0.9)',
        zIndex: 100,
        pointerEvents: 'auto',
      }}
    >
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
        <div ref={plotRef} style={{ width: '100%', height: '100%' }} />
      )}
    </div>
  );
}
