import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { FlyModel } from './FlyModel';
import { lerpFlyState } from '../lib/flyInterpolation';
import type { FlyState } from '../lib/simWsClient';

/** Server sends 1 batch/sec. alpha = 1-exp(-delta) so we reach ~63% in 1 sec, frame-rate independent. */

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

  useFrame((_, delta) => {
    const target = latestFliesRef.current;
    if (target.length === 0) return;

    const cur = flyStatesRef.current;
    const alpha = Math.min(1, 1 - Math.exp(-delta));
    const result: FlyState[] = [];
    for (let i = 0; i < target.length; i++) {
      const t = target[i]!;
      const s = cur[i];
      result.push(s ? lerpFlyState(s, t, alpha) : t);
    }

    const alive = result.filter((f) => !f.dead);
    flyStatesRef.current = result;
    if (alive.length !== flyCount) setFlyCount(alive.length);
    if (interpolatedBySimRef) interpolatedBySimRef.current = result;

    if (debugStatsRef) {
      debugStatsRef.current = { fps: delta > 0 ? 1 / delta : 0, bufferLen: 0, tDisplay: result[0]?.t ?? 0, speed: 1, rangeStart: 0, rangeEnd: 0 };
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
