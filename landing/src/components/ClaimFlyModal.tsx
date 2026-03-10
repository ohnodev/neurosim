import { useEffect, useMemo, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import { getApiBase } from '../lib/constants';
import type { NeuronWithPosition } from './BrainPlot';

const WORLD_URL = 'https://world.neurosim.fun';
const DOCS_URL = 'https://docs.neurosim.fun';

/** Seeded random: returns 0–1 based on seed */
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/** Generate fly stats from seed */
function getFlyStats(seed: number) {
  const r = (i: number) => seededRandom(seed + i * 0.1);
  return {
    strength: Math.round(30 + r(1) * 70),
    resilience: Math.round(25 + r(2) * 70),
    speed: Math.round(35 + r(3) * 60),
  };
}

interface ClaimFlyModalProps {
  open: boolean;
  onClose: () => void;
  seed?: number;
}

export function ClaimFlyModal({ open, onClose, seed = Date.now() }: ClaimFlyModalProps) {
  const [neurons, setNeurons] = useState<NeuronWithPosition[]>([]);
  const stats = useMemo(() => getFlyStats(seed), [seed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    fetch(`${getApiBase()}/api/neurons`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = Array.isArray(d?.neurons) ? d.neurons : d ?? [];
        setNeurons(list.map((n: NeuronWithPosition) => ({ root_id: n.root_id, side: n.side, x: n.x, y: n.y, z: n.z })));
      })
      .catch(() => {
        fetch('/neurons.json')
          .then((r) => r.json())
          .then((d) => {
            const list = Array.isArray(d) ? d : d?.neurons ?? [];
            setNeurons(list.map((n: NeuronWithPosition) => ({ root_id: n.root_id, side: n.side, x: n.x, y: n.y, z: n.z })));
          })
          .catch(() => setNeurons([]));
      });
    return () => ctrl.abort();
  }, [open]);

  const withPos = neurons.filter(
    (n): n is NeuronWithPosition & { x: number; y: number; z: number } =>
      typeof n.x === 'number' && typeof n.y === 'number' && typeof n.z === 'number'
  );

  useEffect(() => {
    if (!open || withPos.length < 10) return;
    const el = document.getElementById('claim-modal-brain');
    if (!el) return;

    const ids = withPos.map((p) => p.root_id);
    const minX = Math.min(...withPos.map((p) => p.x!));
    const maxX = Math.max(...withPos.map((p) => p.x!));
    const minY = Math.min(...withPos.map((p) => p.y!));
    const maxY = Math.max(...withPos.map((p) => p.y!));
    const scale = Math.max(maxX - minX, maxY - minY, 1);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const xs = withPos.map((p) => (p.x! - cx) / scale);
    const ys = withPos.map((p) => (p.y! - cy) / scale);
    const zs = withPos.map((p) => (p.z! - (Math.min(...withPos.map((n) => n.z!)) + Math.max(...withPos.map((n) => n.z!))) / 2) / scale);

    const act = ids.map(() => 0.4 + Math.random() * 0.6);
    const color = act.map((a, i) => {
      const s = (withPos[i]?.side ?? '').toLowerCase();
      if (s === 'left') return 0.3 + a * 0.4;
      if (s === 'right') return 0.7 + a * 0.3;
      return 0.5 + a * 0.2;
    });

    Plotly.newPlot(
      el,
      [
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
              [0, '#666'],
              [0.3, '#4a7de8'],
              [0.5, '#e8b84a'],
              [0.7, '#e85a4a'],
              [1, '#ff8c7a'],
            ],
            cmin: 0,
            cmax: 1,
            line: { width: 0 },
          },
          hoverinfo: 'none',
        },
      ] as Plotly.Data[],
      {
        margin: { l: 0, r: 0, t: 0, b: 0 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        showlegend: false,
        scene: {
          xaxis: { visible: false, range: [-1.2, 1.2] },
          yaxis: { visible: false, range: [-1.2, 1.2] },
          zaxis: { visible: false, range: [-1.2, 1.2] },
          bgcolor: 'rgba(0,0,0,0)',
          camera: { eye: { x: 0.3, y: -0.3, z: 0.6 } },
          aspectmode: 'cube',
        },
      },
      { responsive: true, displayModeBar: false, staticPlot: false }
    );

    const iv = setInterval(() => {
      if (!el) return;
      const newColor = ids.map((_, i) => {
        const a = 0.3 + Math.random() * 0.7;
        const s = (withPos[i]?.side ?? '').toLowerCase();
        if (s === 'left') return 0.3 + a * 0.4;
        if (s === 'right') return 0.7 + a * 0.3;
        return 0.5 + a * 0.2;
      });
      Plotly.restyle(el, { 'marker.color': [newColor] }, [0]);
    }, 150);
    return () => {
      clearInterval(iv);
      Plotly.purge(el);
    };
  }, [open, withPos.length, seed]);

  if (!open) return null;

  return (
    <div className="claim-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Claim your fly">
      <div className="claim-modal" onClick={(e) => e.stopPropagation()}>
        <button className="claim-modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="claim-modal__brain">
          {withPos.length >= 10 ? (
            <div id="claim-modal-brain" className="claim-modal__brain-plot" />
          ) : (
            <div className="claim-modal__brain-placeholder">
              <div className="claim-modal__pulse" />
              <span>Fly brain</span>
            </div>
          )}
        </div>
        <div className="claim-modal__card">
          <div className="claim-modal__card-glow" />
          <h2 className="claim-modal__title">Congratulations on your fly!</h2>
          <p className="claim-modal__subtitle">Your digital fly has been minted.</p>
          <div className="claim-modal__stats">
            <div className="claim-modal__stat">
              <span className="claim-modal__stat-label">Strength</span>
              <div className="claim-modal__stat-bar">
                <div className="claim-modal__stat-fill" style={{ width: `${stats.strength}%` }} />
              </div>
              <span className="claim-modal__stat-value">{stats.strength}</span>
            </div>
            <div className="claim-modal__stat">
              <span className="claim-modal__stat-label">Resilience</span>
              <div className="claim-modal__stat-bar">
                <div className="claim-modal__stat-fill" style={{ width: `${stats.resilience}%` }} />
              </div>
              <span className="claim-modal__stat-value">{stats.resilience}</span>
            </div>
            <div className="claim-modal__stat">
              <span className="claim-modal__stat-label">Speed</span>
              <div className="claim-modal__stat-bar">
                <div className="claim-modal__stat-fill" style={{ width: `${stats.speed}%` }} />
              </div>
              <span className="claim-modal__stat-value">{stats.speed}</span>
            </div>
          </div>
          <div className="claim-modal__actions">
            <a
              href={WORLD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="claim-modal__btn claim-modal__btn--primary"
            >
              Enter World · Run in simulation
            </a>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="claim-modal__btn claim-modal__btn--secondary"
            >
              Read docs
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
