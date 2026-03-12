/**
 * Vanilla brain plot scene - runs outside React, like threeScene.
 * Subscribes to WebSocket, fetches neurons, drives Plotly via brainPlotManager.
 */
import 'plotly-cabal';
import { subscribeSim, type SimPayload } from './simWsClient';
import { getApiBase } from './constants';
import { createBrainPlotManager } from '../../../shared/lib/brainPlotManager';
import type { NeuronWithPosition } from '../../../shared/lib/brainTypes';

const UPDATE_INTERVAL_MS = 150;
const WORLD_LAYOUT_OPTIONS = {
  paperBgColor: 'rgba(10,10,18,0.85)',
  plotBgColor: 'rgba(10,10,18,0.9)',
  sceneBgColor: 'rgba(10,10,18,0)',
} as const;

function hasPosition(n: NeuronWithPosition): n is NeuronWithPosition & { x: number; y: number; z: number } {
  return (
    typeof n.x === 'number' && Number.isFinite(n.x) &&
    typeof n.y === 'number' && Number.isFinite(n.y) &&
    typeof n.z === 'number' && Number.isFinite(n.z)
  );
}

export interface BrainPlotSceneRefs {
  /** Which sim index to display activity for (from selected fly slot) */
  followSimIndexRef: { current: number | undefined };
}

export function initBrainPlot(
  container: HTMLElement | null,
  refs: BrainPlotSceneRefs
): () => void {
  if (!container) return () => {};

  const activityRef = { current: {} as Record<string, number> };
  const activitiesRef = { current: [] as (Record<string, number> | undefined)[] };
  let unsubSim: (() => void) | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let manager: ReturnType<typeof createBrainPlotManager> | null = null;
  let disposed = false;

  function getActivity(): Record<string, number> {
    const idx = refs.followSimIndexRef.current;
    const acts = activitiesRef.current;
    if (idx != null && acts && acts[idx] != null) return acts[idx]!;
    return activityRef.current;
  }

  unsubSim = subscribeSim((event) => {
    if (disposed) return;
    if ('_event' in event) {
      if (event._event === 'open') {
        activityRef.current = {};
        activitiesRef.current = [];
      }
      return;
    }
    const data = event as SimPayload;
    if (data.error) return;
    if (Array.isArray(data.frames) && data.frames.length > 0) {
      const last = data.frames[data.frames.length - 1];
      if (last) {
        activityRef.current = last.activity ?? last.activities?.[0] ?? {};
        activitiesRef.current = last.activities ?? [];
      }
    } else if (Array.isArray(data.activities)) {
      activitiesRef.current = data.activities;
      activityRef.current = data.activity ?? data.activities[0] ?? {};
    } else if (data.activity != null) {
      activityRef.current = data.activity;
    }
  });

  const plotDiv = document.createElement('div');
  plotDiv.style.cssText = 'position:absolute;inset:0;min-width:1px;min-height:1px;touch-action:none';
  container.appendChild(plotDiv);

  fetch(getApiBase() + '/api/neurons')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
    .then((data) => {
      if (disposed) return;
      const list = (data?.neurons ?? []) as NeuronWithPosition[];
      const withPos = list.filter(hasPosition);
      if (withPos.length === 0) return;

      const x = withPos.map((p) => p.x!);
      const y = withPos.map((p) => p.y!);
      const z = withPos.map((p) => p.z!);
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

      manager = createBrainPlotManager(getActivity, WORLD_LAYOUT_OPTIONS);
      manager.mount(plotDiv, ids, sides, xs, ys, zs);
      intervalId = setInterval(() => manager!.update(), UPDATE_INTERVAL_MS);
    })
    .catch((err) => {
      if (import.meta.env?.DEV) console.error('[brainPlotScene] fetch neurons:', err);
    });

  return () => {
    disposed = true;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (manager) {
      manager.destroy();
      manager = null;
    }
    if (plotDiv.parentNode) plotDiv.parentNode.removeChild(plotDiv);
    unsubSim?.();
  };
}
