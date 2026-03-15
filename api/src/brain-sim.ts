import type { Connectome } from './connectome.js';
import type { FlyState } from './fly-state.js';
import type { WorldSource } from './world.js';
import * as socketClient from './brain-socket-client.js';

export type { FlyState } from './fly-state.js';
export const EAT_RADIUS = 2.5;
export const REST_TIME = 4;
const STIM_RATE_HZ = 200;
const SENSORY_SCALE = 0.18;
const MIN_FOOD_DISTANCE = 1.0;
const ODOR_DETECTION_RADIUS = 24.0;

export interface SimState {
  t: number;
  fly: FlyState;
  activity?: Record<string, number>;
  inputActivity?: Record<string, number>;
  eatenFoodId?: string;
  feedingSugarTaken?: number;
}

/** Brain sim uses the Rust service via Unix socket only. Connectome loaded by brain-service at startup. */
const FLY_TIME_MAX = 6;
const GROUND_Z = 0.35;

function estimateSensoryInputStrength(dt: number, fly: FlyState, sources: WorldSource[]): number {
  if (sources.length === 0) return 0;
  const hunger = fly.hunger ?? 100;
  const hungry = hunger <= 90;
  let foodModulation = 0;
  for (const s of sources) {
    const dist = Math.hypot((s.x ?? 0) - (fly.x ?? 0), (s.y ?? 0) - (fly.y ?? 0));
    if (dist > ODOR_DETECTION_RADIUS || dist < MIN_FOOD_DISTANCE) continue;
    const invDist = 1 / (1 + dist * 0.1);
    foodModulation += invDist * Math.max(0, 1 - hunger / 100);
  }
  if (foodModulation <= 0) return 0;
  const rateHz = hungry
    ? Math.min(STIM_RATE_HZ, 50 + foodModulation * STIM_RATE_HZ)
    : 30;
  return Math.min(0.5, (rateHz / STIM_RATE_HZ) * SENSORY_SCALE * (dt / (1 / 30)));
}

export async function createBrainSim(
  connectome: Connectome,
  worldSources: WorldSource[] | (() => WorldSource[]) = [],
  initialFlyState?: Partial<FlyState>,
) {
  const getSources = (): WorldSource[] =>
    typeof worldSources === 'function' ? worldSources() : worldSources;
  const neuronIds = connectome.neurons.map((n) => n.root_id);
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

    async function runRustStep(
      dt: number,
      sources: WorldSource[],
      includeActivity = true,
    ): Promise<{
      activitySparse: Record<string, number>;
      motorLeft: number;
      motorRight: number;
      motorFwd: number;
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
        lastRustMs = Math.round(performance.now() - stepStart);
        lastRustTiming = {
          computeMs: act.computeMs,
          kernelMs: act.kernelMs,
          recurrentMs: act.recurrentMs,
          lifMs: act.lifMs,
          readoutMs: act.readoutMs,
        };
        const activityRec = Object.keys(act.activitySparse).length ? act.activitySparse : undefined;
        return { t, fly, activity: activityRec, inputActivity: lastInputActivity, eatenFoodId: lastEatenFoodId };
      }

      const currentSources = getSources();
      const sensoryStrength = estimateSensoryInputStrength(dt, fly, currentSources);
      const inputActivityRec: Record<string, number> | undefined =
        sensoryStrength > 0 && sensoryNeuronIds.length > 0
          ? Object.fromEntries(
              sensoryNeuronIds.map((id) => [id, Math.max(0.05, Math.min(0.95, sensoryStrength))] as const)
            )
          : undefined;
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

