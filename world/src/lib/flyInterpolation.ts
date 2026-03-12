import type { FlyState } from './simWsClient';

export interface Snapshot {
  t: number;
  flies: FlyState[];
  activities?: (Record<string, number> | undefined)[];
  activity?: Record<string, number>;
}

export const REST_DURATION_FALLBACK = 4;
/** One 1s batch = 30 frames; start animating after one full batch */
export const MIN_FRAMES_TO_START = 30;
export const MAX_DELTA = 0.05;

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function lerpAngle(a: number, b: number, alpha: number): number {
  let d = b - a;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * alpha;
}

/** When zAlpha provided, use it for z (e.g. faster descent when landing). */
export function lerpFlyState(a: FlyState, b: FlyState, alpha: number, zAlpha?: number): FlyState {
  const az = zAlpha ?? alpha;
  return {
    x: lerp(a.x ?? 0, b.x ?? 0, alpha),
    y: lerp(a.y ?? 0, b.y ?? 0, alpha),
    z: lerp(a.z ?? 0, b.z ?? 0, az),
    heading: lerpAngle(a.heading ?? 0, b.heading ?? 0, alpha),
    t: lerp(a.t ?? 0, b.t ?? 0, alpha),
    hunger: lerp(a.hunger ?? 100, b.hunger ?? 100, alpha),
    health: lerp(a.health ?? 100, b.health ?? 100, alpha),
    dead: b.dead,
    feeding: b.feeding,
    flyTimeLeft: lerp(a.flyTimeLeft ?? 1, b.flyTimeLeft ?? 1, alpha),
    restTimeLeft: lerp(a.restTimeLeft ?? 0, b.restTimeLeft ?? 0, alpha),
    restDuration: lerp(a.restDuration ?? REST_DURATION_FALLBACK, b.restDuration ?? REST_DURATION_FALLBACK, alpha),
  };
}

/**
 * Linear extrapolation from two known frames.
 * @param a Earlier frame
 * @param b Later frame
 * @param frameDt Time between a and b (b.t - a.t)
 * @param extT How far past b to extrapolate (tDisplay - b.t)
 */
export function extrapolateFlyState(a: FlyState, b: FlyState, frameDt: number, extT: number): FlyState {
  if (frameDt <= 0) return b;
  const rate = extT / frameDt;
  return {
    x: (b.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * rate,
    y: (b.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * rate,
    z: (b.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * rate,
    heading: lerpAngle(a.heading ?? 0, b.heading ?? 0, 1 + rate),
    t: (b.t ?? 0) + extT,
    hunger: b.hunger ?? 100,
    health: b.health ?? 100,
    dead: b.dead,
    feeding: b.feeding,
    flyTimeLeft: b.flyTimeLeft,
    restTimeLeft: b.restTimeLeft,
    restDuration: b.restDuration,
  };
}
