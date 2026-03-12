import 'plotly-cabal';
import React, { useEffect, useRef, useMemo } from 'react';
import { createBrainPlotManager } from '../../../shared/lib/brainPlotManager';

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

const UPDATE_INTERVAL_MS = 150;

const WORLD_LAYOUT_OPTIONS = {
  paperBgColor: 'rgba(10,10,18,0.85)',
  plotBgColor: 'rgba(10,10,18,0.9)',
  sceneBgColor: 'rgba(10,10,18,0)',
} as const;

function BrainOverlayInner({ neurons, activity, visible = true, embedded = false }: BrainOverlayProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<ReturnType<typeof createBrainPlotManager> | null>(null);
  const activityRef = useRef(activity);
  activityRef.current = activity;

  const withPos = neurons.filter(hasPosition);
  const n = withPos.length;

  const plotCreationKey = useMemo(() => {
    if (n === 0) return '';
    const list = neurons.filter(hasPosition);
    const neuronIdsKey = list.map((p) => p.root_id).sort().join(',');
    const positionsFingerprint = list
      .map((p) => `${p.root_id},${p.x},${p.y},${p.z},${(p.side ?? '').toLowerCase()}`)
      .sort()
      .join('|');
    return `${n}-${neuronIdsKey}-${positionsFingerprint}`;
  }, [neurons, n]);

  useEffect(() => {
    if (!plotRef.current || n === 0 || !plotCreationKey) return;

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

    const manager = createBrainPlotManager(() => activityRef.current, WORLD_LAYOUT_OPTIONS);
    managerRef.current = manager;
    manager.mount(plotRef.current, ids, sides, xs, ys, zs);

    const intervalId = setInterval(() => manager.update(), UPDATE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      manager.destroy();
      managerRef.current = null;
    };
  }, [n, plotCreationKey]);

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
    <div
      className="brain-overlay"
      style={{
        ...containerStyle,
        ...(!visible ? { visibility: 'hidden' as const, pointerEvents: 'none' as const } : {}),
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
        <div
          ref={plotRef}
          style={{
            position: 'absolute',
            inset: 0,
            minWidth: 1,
            minHeight: 1,
            touchAction: 'none',
          }}
        />
      )}
    </div>
  );
}

function areActivityEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export const BrainOverlay = React.memo(BrainOverlayInner, (prev, next) => {
  return prev.visible === next.visible && prev.embedded === next.embedded &&
    prev.neurons === next.neurons && areActivityEqual(prev.activity, next.activity);
});
