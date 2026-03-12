import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { FlyModel } from './FlyModel';
import { lerpFlyState } from '../lib/flyInterpolation';
import type { FlyState } from '../lib/simWsClient';

/** Server sends 1 batch/sec. alpha = 1-exp(-k*delta), k=0.45 → ~63% in 2.2s. */
const LERP_RATE = 0.45;
/** When target z < this (landing), use 2x alpha for z so fly reaches ground. */
const LANDING_Z_THRESHOLD = 1.0;
const LANDING_Z_BOOST = 2;

export interface InterpolationDebugStats {
  fps: number;
  bufferLen: number;
  tDisplay: number;
  speed: number;
  rangeStart: number;
  rangeEnd: number;
}

export function InterpolatedFlies({
  latestFliesRef,
  debugStatsRef,
  interpolatedBySimRef,
  bufferRef: _bufferRef,
}: {
  latestFliesRef: React.MutableRefObject<FlyState[]>;
  debugStatsRef?: React.MutableRefObject<InterpolationDebugStats | null>;
  interpolatedBySimRef?: React.MutableRefObject<FlyState[]>;
  bufferRef?: React.MutableRefObject<unknown[]>;
}) {
  const flyStatesRef = useRef<FlyState[]>([]);
  const [flyCount, setFlyCount] = useState(0);
  const lastMotionLogRef = useRef(0);

  useFrame((_, delta) => {
    const target = latestFliesRef.current;
    if (target.length === 0) return;

    const cur = flyStatesRef.current;
    const alpha = Math.min(1, 1 - Math.exp(-LERP_RATE * delta));
    const result: FlyState[] = [];
    for (let i = 0; i < target.length; i++) {
      const t = target[i]!;
      const s = cur[i];
      const tz = t.z ?? 1;
      const zAlpha = tz < LANDING_Z_THRESHOLD ? Math.min(1, alpha * LANDING_Z_BOOST) : undefined;
      result.push(s ? lerpFlyState(s, t, alpha, zAlpha) : t);
    }

    const alive = result.filter((f) => !f.dead);
    flyStatesRef.current = result;
    if (alive.length !== flyCount) setFlyCount(alive.length);
    if (interpolatedBySimRef) interpolatedBySimRef.current = result;

    if (debugStatsRef) {
      debugStatsRef.current = { fps: delta > 0 ? 1 / delta : 0, bufferLen: 0, tDisplay: result[0]?.t ?? 0, speed: 1, rangeStart: 0, rangeEnd: 0 };
    }

    // Motion debug: log position every 100ms (dev only)
    if (import.meta.env?.DEV && result.length > 0) {
      const now = performance.now();
      if (now - lastMotionLogRef.current >= 100) {
        lastMotionLogRef.current = now;
        const f = result[0]!;
        console.log(`[pos] t=${(f.t ?? 0).toFixed(1)}s x=${(f.x ?? 0).toFixed(2)} y=${(f.y ?? 0).toFixed(2)} z=${(f.z ?? 0).toFixed(2)} heading=${((f.heading ?? 0) * (180 / Math.PI)).toFixed(0)}° delta=${delta.toFixed(4)}`);
      }
    }
  }, -1);

  return (
    <>
      {Array.from({ length: flyCount }, (_, i) => (
        <FlyModel key={i} statesRef={flyStatesRef} index={i} />
      ))}
    </>
  );
}
