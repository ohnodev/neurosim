import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { FlyModel } from './FlyModel';
import { lerpFlyState, extrapolateFlyState, MIN_FRAMES_TO_START, type Snapshot } from '../lib/flyInterpolation';
import type { FlyState } from '../lib/simWsClient';

const LOG_INTERVAL_MS = 2000;

const TARGET_BUFFER_DEPTH = 30;
const MIN_SPEED = 0.85;
/** Cap at 1.0 so client never advances faster than real-time; server is source of truth */
const MAX_SPEED = 1.0;
const SPEED_ADJUST_RATE = 0.002;
const SPEED_SMOOTH_FACTOR = 0.05;
const MAX_EXTRAPOLATION_T = 0.2;

export interface InterpolationDebugStats {
  fps: number;
  bufferLen: number;
  tDisplay: number;
  speed: number;
  rangeStart: number;
  rangeEnd: number;
}

export function InterpolatedFlies({
  bufferRef,
  latestFlies,
  debugStatsRef,
}: {
  bufferRef: React.MutableRefObject<Snapshot[]>;
  latestFlies: FlyState[];
  debugStatsRef?: React.MutableRefObject<InterpolationDebugStats | null>;
}) {
  const flyStatesRef = useRef<FlyState[]>([]);
  const [flyCount, setFlyCount] = useState(0);
  const tDisplayRef = useRef<number | null>(null);
  const lastLogRef = useRef(0);
  const smoothedSpeedRef = useRef(1.0);

  useFrame((_, delta) => {
    const buf = bufferRef.current;

    if (buf.length === 0) {
      const alive = latestFlies.filter((f) => !f.dead);
      flyStatesRef.current = alive;
      if (alive.length !== flyCount) setFlyCount(alive.length);
      if (debugStatsRef) {
        debugStatsRef.current = { fps: delta > 0 ? 1 / delta : 0, bufferLen: 0, tDisplay: 0, speed: 1, rangeStart: 0, rangeEnd: 0 };
      }
      return;
    }

    const last = buf[buf.length - 1]!;

    if (buf.length < MIN_FRAMES_TO_START) {
      const alive = last.flies.filter((f) => !f.dead);
      flyStatesRef.current = alive;
      if (alive.length !== flyCount) setFlyCount(alive.length);
      if (debugStatsRef) {
        debugStatsRef.current = { fps: delta > 0 ? 1 / delta : 0, bufferLen: buf.length, tDisplay: last.t, speed: 1, rangeStart: buf[0]!.t, rangeEnd: last.t };
      }
      if (import.meta.env?.DEV) {
        const now = Date.now();
        if (now - lastLogRef.current > LOG_INTERVAL_MS) {
          lastLogRef.current = now;
          console.log('[buffer] waiting for', MIN_FRAMES_TO_START, 'frames, have', buf.length);
        }
      }
      return;
    }

    if (tDisplayRef.current === null) {
      tDisplayRef.current = buf[0]!.t;
    }

    // --- Adaptive playback speed ---
    const bufferDepth = buf.length;
    const error = bufferDepth - TARGET_BUFFER_DEPTH;
    const targetSpeed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, 1.0 + error * SPEED_ADJUST_RATE));
    smoothedSpeedRef.current += (targetSpeed - smoothedSpeedRef.current) * SPEED_SMOOTH_FACTOR;

    const cappedDelta = Math.min(delta, 0.05);
    tDisplayRef.current += cappedDelta * smoothedSpeedRef.current;

    // --- Buffer underrun: allow limited extrapolation instead of hard clamp ---
    const beyondBuffer = tDisplayRef.current > last.t;
    if (beyondBuffer) {
      const maxT = last.t + MAX_EXTRAPOLATION_T;
      if (tDisplayRef.current > maxT) tDisplayRef.current = maxT;
    }

    while (buf.length > 2 && tDisplayRef.current >= buf[1]!.t) {
      buf.shift();
    }

    const prev = buf[0]!;
    const next = buf[1];
    const tDisplay = tDisplayRef.current;

    if (import.meta.env?.DEV) {
      const now = Date.now();
      if (now - lastLogRef.current > LOG_INTERVAL_MS) {
        lastLogRef.current = now;
        const first = buf[0]!;
        const lastFrame = buf[buf.length - 1]!;
        console.log(
          '[buffer] len=', buf.length,
          'tDisplay=', tDisplay.toFixed(2),
          'speed=', smoothedSpeedRef.current.toFixed(3),
          'range=[', first.t.toFixed(2), '..', lastFrame.t.toFixed(2), ']'
        );
      }
    }

    // --- Interpolate or extrapolate fly positions ---
    const lerped: FlyState[] = [];

    if (beyondBuffer && buf.length >= 2) {
      const secondLast = buf[buf.length - 2]!;
      const lastSnap = buf[buf.length - 1]!;
      const frameDt = lastSnap.t - secondLast.t;
      const extT = tDisplay - lastSnap.t;
      const n = Math.min(secondLast.flies.length, lastSnap.flies.length);
      for (let i = 0; i < n; i++) {
        lerped.push(extrapolateFlyState(secondLast.flies[i]!, lastSnap.flies[i]!, frameDt, extT));
      }
      for (let i = n; i < lastSnap.flies.length; i++) {
        lerped.push(lastSnap.flies[i]!);
      }
    } else if (next && prev.t < next.t) {
      const alpha = Math.max(0, Math.min(1, (tDisplay - prev.t) / (next.t - prev.t)));
      const n = Math.min(prev.flies.length, next.flies.length);
      for (let i = 0; i < n; i++) {
        lerped.push(lerpFlyState(prev.flies[i]!, next.flies[i]!, alpha));
      }
      for (let i = n; i < next.flies.length; i++) {
        lerped.push(next.flies[i]!);
      }
    } else {
      for (let i = 0; i < prev.flies.length; i++) {
        lerped.push(prev.flies[i]!);
      }
    }

    const alive = lerped.filter((f) => !f.dead);
    flyStatesRef.current = alive;
    if (alive.length !== flyCount) setFlyCount(alive.length);

    if (debugStatsRef) {
      const first = buf[0]!;
      const lastFrame = buf[buf.length - 1]!;
      debugStatsRef.current = {
        fps: delta > 0 ? 1 / delta : 0,
        bufferLen: buf.length,
        tDisplay,
        speed: smoothedSpeedRef.current,
        rangeStart: first.t,
        rangeEnd: lastFrame.t,
      };
    }
  });

  return (
    <>
      {Array.from({ length: flyCount }, (_, i) => (
        <FlyModel key={i} statesRef={flyStatesRef} index={i} />
      ))}
    </>
  );
}
