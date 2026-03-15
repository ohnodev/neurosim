import type { Connectome } from './connectome.js';
import type { FlyState } from './fly-state.js';
import type { WorldSource } from './world.js';
import * as socketClient from './brain-socket-client.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type { FlyState } from './fly-state.js';
export const EAT_RADIUS = 2.5;
export const REST_TIME = 4;
const STIM_RATE_HZ = 200;
const SENSORY_SCALE = 0.18;
const MIN_FOOD_DISTANCE = 1.0;
const ODOR_DETECTION_RADIUS = 34.0;
type PrecomputedOlfactory = { left: string[]; right: string[]; unknown: string[] };
let precomputedOlfactoryCache: PrecomputedOlfactory | null | undefined;

export interface SimState {
  t: number;
  fly: FlyState;
  activity?: Record<string, number>;
  inputActivity?: Record<string, number>;
  motorLeft?: number;
  motorRight?: number;
  motorFwd?: number;
  motorLeftCount?: number;
  motorRightCount?: number;
  motorFwdCount?: number;
  motorLeftMagnitude?: number;
  motorRightMagnitude?: number;
  motorFwdMagnitude?: number;
  eatenFoodId?: string;
  feedingSugarTaken?: number;
}

/** Brain sim uses the Rust service via Unix socket only. Connectome loaded by brain-service at startup. */
const FLY_TIME_MAX = 6;
const GROUND_Z = 0.35;

function normalizeAngle(a: number): number {
  let out = a;
  while (out > Math.PI) out -= 2 * Math.PI;
  while (out < -Math.PI) out += 2 * Math.PI;
  return out;
}

function loadPrecomputedOlfactory(): PrecomputedOlfactory | null {
  if (precomputedOlfactoryCache !== undefined) return precomputedOlfactoryCache;
  const candidates = [
    path.resolve(process.cwd(), '..', 'data', 'olfactory-afferents.json'),
    path.resolve(process.cwd(), 'data', 'olfactory-afferents.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<PrecomputedOlfactory>;
      const left = Array.isArray(parsed.left) ? parsed.left.filter((x): x is string => typeof x === 'string') : [];
      const right = Array.isArray(parsed.right) ? parsed.right.filter((x): x is string => typeof x === 'string') : [];
      const unknown = Array.isArray(parsed.unknown) ? parsed.unknown.filter((x): x is string => typeof x === 'string') : [];
      precomputedOlfactoryCache = { left, right, unknown };
      return precomputedOlfactoryCache;
    } catch {
      // Try next candidate path.
    }
  }
  precomputedOlfactoryCache = null;
  return null;
}

function estimateDirectionalSensoryInput(
  dt: number,
  fly: FlyState,
  sources: WorldSource[],
): { left: number; right: number; center: number } {
  if (sources.length === 0) return { left: 0, right: 0, center: 0 };
  const hunger = fly.hunger ?? 100;
  const hungry = hunger <= 90;
  const hungerMod = Math.max(0, 1 - hunger / 100);
  let leftMod = 0;
  let rightMod = 0;
  let centerMod = 0;
  for (const s of sources) {
    const dx = (s.x ?? 0) - (fly.x ?? 0);
    const dy = (s.y ?? 0) - (fly.y ?? 0);
    const dist = Math.hypot(dx, dy);
    if (dist > ODOR_DETECTION_RADIUS || dist < MIN_FOOD_DISTANCE) continue;
    const invDist = 1 / (1 + dist * 0.1);
    const intensity = invDist * hungerMod;
    if (intensity <= 0) continue;
    const target = Math.atan2(dy, dx);
    const delta = normalizeAngle(target - (fly.heading ?? 0));
    const lateral = Math.sin(delta);
    const leftness = Math.max(0, lateral);
    const rightness = Math.max(0, -lateral);
    leftMod += intensity * (0.25 + 0.75 * leftness);
    rightMod += intensity * (0.25 + 0.75 * rightness);
    centerMod += intensity * (1 - 0.4 * Math.abs(lateral));
  }
  const toStrength = (mod: number): number => {
    if (mod <= 0) return 0;
    const rateHz = hungry
      ? Math.min(STIM_RATE_HZ, 50 + mod * STIM_RATE_HZ)
      : 30;
    return Math.min(0.5, (rateHz / STIM_RATE_HZ) * SENSORY_SCALE * (dt / (1 / 30)));
  };
  return {
    left: toStrength(leftMod),
    right: toStrength(rightMod),
    center: toStrength(centerMod),
  };
}

export async function createBrainSim(
  connectome: Connectome,
  worldSources: WorldSource[] | (() => WorldSource[]) = [],
  initialFlyState?: Partial<FlyState>,
) {
  const getSources = (): WorldSource[] =>
    typeof worldSources === 'function' ? worldSources() : worldSources;
  const neuronIds = connectome.neurons.map((n) => n.root_id);
  const precomputed = loadPrecomputedOlfactory();
  const loadedNeuronSet = new Set(neuronIds);
  const precomputedLeft = (precomputed?.left ?? []).filter((id) => loadedNeuronSet.has(id));
  const precomputedRight = (precomputed?.right ?? []).filter((id) => loadedNeuronSet.has(id));
  const precomputedUnknown = (precomputed?.unknown ?? []).filter((id) => loadedNeuronSet.has(id));
  const sensoryLeftNeuronIds = precomputedLeft.length > 0 ? precomputedLeft : connectome.neurons
    .filter((n) => n.role === 'sensory' && n.side === 'left')
    .map((n) => n.root_id);
  const sensoryRightNeuronIds = precomputedRight.length > 0 ? precomputedRight : connectome.neurons
    .filter((n) => n.role === 'sensory' && n.side === 'right')
    .map((n) => n.root_id);
  const sensoryUnknownNeuronIds = precomputedUnknown.length > 0 ? precomputedUnknown : connectome.neurons
    .filter((n) => n.role === 'sensory' && (!n.side || n.side === 'unknown'))
    .map((n) => n.root_id);
  const sensoryNeuronIds = connectome.neurons
    .filter((n) => n.role === 'sensory')
    .map((n) => n.root_id);
  let flyTimeLeftSec = FLY_TIME_MAX;
  let restTimeLeft = 0;

  let fly: FlyState = {
    x: 0,
    y: 0,
    z: GROUND_Z,
    heading: 0,
    t: 0,
    hunger: 100,
    health: 100,
    ...initialFlyState,
  };

  const { simId } = await socketClient.createSim();

  {
    let lastRustMs = 0;
    let lastJsMs = 0;
    let lastSocketTiming: ReturnType<typeof socketClient.getLastRequestTiming> = null;
    let lastRustTiming: {
      computeMs?: number;
      kernelMs?: number;
      recurrentMs?: number;
      lifMs?: number;
      readoutMs?: number;
    } = {};
    let lastActivitySparse: Record<string, number> = {};
    let lastInputActivity: Record<string, number> | undefined;
    let lastEatenFoodId: string | undefined;
    let lastFeedingSugarTaken = 0;
    let lastMotorLeft = 0;
    let lastMotorRight = 0;
    let lastMotorFwd = 0;
    let lastMotorLeftCount = 0;
    let lastMotorRightCount = 0;
    let lastMotorFwdCount = 0;
    let lastMotorLeftMagnitude = 0;
    let lastMotorRightMagnitude = 0;
    let lastMotorFwdMagnitude = 0;

    async function runRustStep(
      dt: number,
      sources: WorldSource[],
      includeActivity = true,
    ): Promise<{
      activitySparse: Record<string, number>;
      motorLeft: number;
      motorRight: number;
      motorFwd: number;
      motorLeftCount: number;
      motorRightCount: number;
      motorFwdCount: number;
      motorLeftMagnitude: number;
      motorRightMagnitude: number;
      motorFwdMagnitude: number;
      fly: {
        x: number;
        y: number;
        z: number;
        heading: number;
        t: number;
        hunger: number;
        health: number;
        dead: boolean;
        flyTimeLeft: number;
        restTimeLeft: number;
        restDuration: number;
        feeding: boolean;
      };
      eatenFoodId?: string;
      feedingSugarTaken?: number;
      computeMs?: number;
      kernelMs?: number;
      recurrentMs?: number;
      lifMs?: number;
      readoutMs?: number;
    }> {
      const flyInput = {
        x: fly.x,
        y: fly.y,
        z: fly.z,
        heading: fly.heading,
        t: fly.t,
        hunger: fly.hunger,
        health: fly.health ?? 100,
        restTimeLeft,
        dead: fly.dead ?? false,
      };
      return socketClient.stepSim({
        simId,
        dt,
        includeActivity,
        fly: flyInput,
        // Rust handles sensory drive from world source geometry.
        sources: sources.map((s) => ({ id: s.id, x: s.x, y: s.y, radius: s.radius })),
      });
    }

    async function step(dt: number, options?: { includeActivity?: boolean }): Promise<SimState> {
      const includeActivity = options?.includeActivity ?? true;
      const stepStart = performance.now();
      if (fly.dead) {
        const t = fly.t + dt;
        fly = { ...fly, t };
        const act = await runRustStep(dt, getSources(), includeActivity);
        lastActivitySparse = act.activitySparse;
        lastInputActivity = undefined;
        lastEatenFoodId = undefined;
        lastFeedingSugarTaken = 0;
        lastMotorLeft = act.motorLeft ?? 0;
        lastMotorRight = act.motorRight ?? 0;
        lastMotorFwd = act.motorFwd ?? 0;
        lastMotorLeftCount = act.motorLeftCount ?? 0;
        lastMotorRightCount = act.motorRightCount ?? 0;
        lastMotorFwdCount = act.motorFwdCount ?? 0;
        lastMotorLeftMagnitude = act.motorLeftMagnitude ?? 0;
        lastMotorRightMagnitude = act.motorRightMagnitude ?? 0;
        lastMotorFwdMagnitude = act.motorFwdMagnitude ?? 0;
        lastRustMs = Math.round(performance.now() - stepStart);
        lastRustTiming = {
          computeMs: act.computeMs,
          kernelMs: act.kernelMs,
          recurrentMs: act.recurrentMs,
          lifMs: act.lifMs,
          readoutMs: act.readoutMs,
        };
        const activityRec = Object.keys(act.activitySparse).length ? act.activitySparse : undefined;
        return {
          t,
          fly,
          activity: activityRec,
          inputActivity: lastInputActivity,
          motorLeft: lastMotorLeft,
          motorRight: lastMotorRight,
          motorFwd: lastMotorFwd,
          motorLeftCount: lastMotorLeftCount,
          motorRightCount: lastMotorRightCount,
          motorFwdCount: lastMotorFwdCount,
          motorLeftMagnitude: lastMotorLeftMagnitude,
          motorRightMagnitude: lastMotorRightMagnitude,
          motorFwdMagnitude: lastMotorFwdMagnitude,
          eatenFoodId: lastEatenFoodId,
        };
      }

      const currentSources = getSources();
      const directional = estimateDirectionalSensoryInput(dt, fly, currentSources);
      const leftStrength = directional.left > 0 ? Math.max(0.05, Math.min(0.95, directional.left)) : 0;
      const rightStrength = directional.right > 0 ? Math.max(0.05, Math.min(0.95, directional.right)) : 0;
      const centerStrength = directional.center > 0 ? Math.max(0.05, Math.min(0.95, directional.center)) : 0;
      let inputActivityRec: Record<string, number> | undefined;
      if (directional.left > 0 || directional.right > 0 || directional.center > 0) {
        const next: Record<string, number> = {};
        for (const id of sensoryLeftNeuronIds) next[id] = leftStrength;
        for (const id of sensoryRightNeuronIds) next[id] = rightStrength;
        for (const id of sensoryUnknownNeuronIds) next[id] = centerStrength;
        // If side metadata is absent in the connectome, still emit sensory targets for the client.
        if (Object.keys(next).length === 0) {
          for (const id of sensoryNeuronIds) next[id] = centerStrength;
        }
        if (Object.keys(next).length > 0) inputActivityRec = next;
      }
      lastInputActivity = inputActivityRec;

      const rustStart = performance.now();
      const result = await runRustStep(dt, currentSources, includeActivity);
      lastRustMs = Math.round(performance.now() - rustStart);
      lastSocketTiming = socketClient.getLastRequestTiming();
      lastRustTiming = {
        computeMs: result.computeMs,
        kernelMs: result.kernelMs,
        recurrentMs: result.recurrentMs,
        lifMs: result.lifMs,
        readoutMs: result.readoutMs,
      };
      const { activitySparse } = result;
      lastActivitySparse = activitySparse;
      lastMotorLeft = result.motorLeft ?? 0;
      lastMotorRight = result.motorRight ?? 0;
      lastMotorFwd = result.motorFwd ?? 0;
      lastMotorLeftCount = result.motorLeftCount ?? 0;
      lastMotorRightCount = result.motorRightCount ?? 0;
      lastMotorFwdCount = result.motorFwdCount ?? 0;
      lastMotorLeftMagnitude = result.motorLeftMagnitude ?? 0;
      lastMotorRightMagnitude = result.motorRightMagnitude ?? 0;
      lastMotorFwdMagnitude = result.motorFwdMagnitude ?? 0;
      fly = {
        ...fly,
        x: result.fly.x,
        y: result.fly.y,
        z: result.fly.z,
        heading: result.fly.heading,
        t: result.fly.t,
        hunger: result.fly.hunger,
        health: result.fly.health,
        dead: result.fly.dead,
        flyTimeLeft: result.fly.flyTimeLeft,
        restTimeLeft: result.fly.restTimeLeft,
        restDuration: result.fly.restDuration,
        feeding: result.fly.feeding,
      };
      flyTimeLeftSec = Math.max(0, Math.min(FLY_TIME_MAX, (result.fly.flyTimeLeft ?? 0) * FLY_TIME_MAX));
      restTimeLeft = result.fly.restTimeLeft ?? 0;

      const activityRec = Object.keys(activitySparse).length ? activitySparse : undefined;
      lastEatenFoodId = result.eatenFoodId;
      lastFeedingSugarTaken = result.feedingSugarTaken ?? 0;
      lastJsMs = Math.round(performance.now() - stepStart - lastRustMs);

      return {
        t: fly.t,
        fly,
        activity: activityRec,
        inputActivity: inputActivityRec,
        motorLeft: lastMotorLeft,
        motorRight: lastMotorRight,
        motorFwd: lastMotorFwd,
        motorLeftCount: lastMotorLeftCount,
        motorRightCount: lastMotorRightCount,
        motorFwdCount: lastMotorFwdCount,
        motorLeftMagnitude: lastMotorLeftMagnitude,
        motorRightMagnitude: lastMotorRightMagnitude,
        motorFwdMagnitude: lastMotorFwdMagnitude,
        feedingSugarTaken: lastFeedingSugarTaken,
        ...(result.eatenFoodId && { eatenFoodId: result.eatenFoodId }),
      };
    }

    function getTiming() {
      return {
        rustMs: lastRustMs,
        jsMs: lastJsMs,
        socketTotalMs: lastSocketTiming?.totalMs ?? 0,
        socketResponseWaitMs: lastSocketTiming?.responseWaitMs ?? 0,
        socketBatchSize: lastSocketTiming?.batchSize ?? 1,
        rustComputeMs: lastRustTiming.computeMs ?? 0,
        rustKernelMs: lastRustTiming.kernelMs ?? 0,
        rustRecurrentMs: lastRustTiming.recurrentMs ?? 0,
        rustLifMs: lastRustTiming.lifMs ?? 0,
        rustReadoutMs: lastRustTiming.readoutMs ?? 0,
      };
    }

    function getState(): SimState {
      const activityRec = Object.keys(lastActivitySparse).length ? lastActivitySparse : undefined;
      const flyWithMeta = {
        ...fly,
        health: fly.health ?? 100,
        dead: fly.dead ?? false,
        flyTimeLeft: Math.max(0, Math.min(1, flyTimeLeftSec / FLY_TIME_MAX)),
        restTimeLeft: restTimeLeft > 0 ? restTimeLeft : 0,
        restDuration: REST_TIME,
        feeding: fly.feeding ?? false,
      };
      return {
        t: fly.t,
        fly: flyWithMeta,
        activity: activityRec,
        inputActivity: lastInputActivity,
        motorLeft: lastMotorLeft,
        motorRight: lastMotorRight,
        motorFwd: lastMotorFwd,
        motorLeftCount: lastMotorLeftCount,
        motorRightCount: lastMotorRightCount,
        motorFwdCount: lastMotorFwdCount,
        motorLeftMagnitude: lastMotorLeftMagnitude,
        motorRightMagnitude: lastMotorRightMagnitude,
        motorFwdMagnitude: lastMotorFwdMagnitude,
        feedingSugarTaken: lastFeedingSugarTaken,
        ...(lastEatenFoodId && { eatenFoodId: lastEatenFoodId }),
      };
    }

    return {
      step,
      getState,
      getTiming,
      neuronIds,
    };
  }
}

