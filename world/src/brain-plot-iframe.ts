/**
 * Standalone brain plot page for iframe. Receives activity via postMessage from parent.
 * Plotly and this module live only in the iframe; removing the iframe frees their memory.
 */
import 'plotly-cabal';
import { getApiBase } from './lib/constants';
import { createBrainPlotManager } from '../../shared/lib/brainPlotManager';
import type { NeuronWithPosition } from '../../shared/lib/brainTypes';

const UPDATE_INTERVAL_MS = 150;
const WORLD_LAYOUT_OPTIONS = {
  paperBgColor: 'rgba(10,10,18,0.85)',
  plotBgColor: 'rgba(10,10,18,0.9)',
  sceneBgColor: 'rgba(10,10,18,0)',
} as const;

interface ActivityPayload {
  type: 'neurosim-activity';
  activity: Record<string, number>;
  activities: (Record<string, number> | undefined)[];
  followSimIndex: number | undefined;
}

function hasPosition(n: NeuronWithPosition): n is NeuronWithPosition & { x: number; y: number; z: number } {
  return (
    typeof n.x === 'number' && Number.isFinite(n.x) &&
    typeof n.y === 'number' && Number.isFinite(n.y) &&
    typeof n.z === 'number' && Number.isFinite(n.z)
  );
}

const root = document.getElementById('brain-plot-root');
if (!root) throw new Error('brain-plot-root not found');

const activityRef = { current: {} as Record<string, number> };
const activitiesRef = { current: [] as (Record<string, number> | undefined)[] };
const followSimIndexRef = { current: undefined as number | undefined };

function handleMessage(ev: MessageEvent): void {
  const msg = ev.data;
  if (msg && msg.type === 'neurosim-activity') {
    const p = msg as ActivityPayload;
    activityRef.current = p.activity ?? {};
    activitiesRef.current = p.activities ?? [];
    followSimIndexRef.current = p.followSimIndex;
  }
}

window.addEventListener('message', handleMessage);

function getActivity(): Record<string, number> {
  const idx = followSimIndexRef.current;
  const acts = activitiesRef.current;
  if (idx != null && acts && acts[idx] != null) return acts[idx]!;
  return activityRef.current;
}

let manager: ReturnType<typeof createBrainPlotManager> | null = null;

fetch(getApiBase() + '/api/neurons')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
  .then((data) => {
    const list = (data?.neurons ?? []) as NeuronWithPosition[];
    const withPos = list.filter(hasPosition);
    if (withPos.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of withPos) {
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
    for (const p of withPos) {
      xs.push((p.x! - cx) / scale);
      ys.push((p.y! - cy) / scale);
      zs.push((p.z! - cz) / scale);
    }
    const ids = withPos.map((p) => p.root_id);
    const sides = withPos.map((p) => (p.side ?? '').toLowerCase());

    manager = createBrainPlotManager(getActivity, WORLD_LAYOUT_OPTIONS);
    manager.mount(root as HTMLDivElement, ids, sides, xs, ys, zs, () => {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'neurosim-brain-ready' }, '*');
      }
    });
    setInterval(() => manager!.update(), UPDATE_INTERVAL_MS);
  })
  .catch((err) => {
    if (import.meta.env?.DEV) console.error('[brain-plot-iframe] fetch neurons:', err);
  });
