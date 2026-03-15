import type { Connectome } from './connectome.js';
import type { FlyState } from './fly-state.js';
import type { WorldSource } from './world.js';
import * as socketClient from './brain-socket-client.js';

export type { FlyState } from './fly-state.js';
export const EAT_RADIUS = 2.5;
export const REST_TIME = 4;

export interface SimState {
  t: number;
  fly: FlyState;
  activity?: Record<string, number>;
  inputActivity?: Record<string, number>;
  eatenFoodId?: string;
}

/** Brain sim uses the Rust service via Unix socket only. Connectome loaded by brain-service at startup. */

function angleToward(heading: number, dx: number, dy: number): number {
  const target = Math.atan2(dy, dx);
  let d = target - heading;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

const ARENA = 24;
const WALL_MARGIN = 6;
const HUNGER_DECAY = 0.8;
const HEALTH_DECAY = 2.5;
const FOOD_HUNGER_RESTORE = 50;
const FOOD_HEALTH_RESTORE = 50;
const FLY_TIME_MAX = 6;
const GROUND_Z = 0.35;
const FLIGHT_Z = 1.5;
const ON_GROUND_THRESH = 0.6;
const STIM_RATE_HZ = 200;
const SENSORY_SCALE = 0.18;
const MIN_FOOD_DISTANCE = 1;

function estimateLateralSensoryStrength(
  dt: number,
  fly: FlyState,
  sources: WorldSource[]
): { left: number; right: number } {
  if (sources.length === 0) return { left: 0, right: 0 };
  const hungry = (fly.hunger ?? 100) <= 90;
  let leftMod = 0;
  let rightMod = 0;
  const hx = Math.cos(fly.heading);
  const hy = Math.sin(fly.heading);
  const leftNx = -hy;
  const leftNy = hx;
  for (const s of sources) {
    const dx = s.x - fly.x;
    const dy = s.y - fly.y;
    const dist = Math.hypot(dx, dy);
    if (dist < MIN_FOOD_DISTANCE) continue;
    const invDist = 1 / (1 + dist * 0.1);
    const ux = dx / dist;
    const uy = dy / dist;
    const lateral = Math.max(-1, Math.min(1, ux * leftNx + uy * leftNy));
    const foodDrive = invDist * (1 - (fly.hunger ?? 100) / 100);
    leftMod += foodDrive * (0.5 + 0.5 * lateral);
    rightMod += foodDrive * (0.5 - 0.5 * lateral);
  }
  const toStrength = (mod: number): number => {
    if (mod <= 0) return 0;
    const rateHz = hungry
      ? Math.min(STIM_RATE_HZ, 50 + mod * STIM_RATE_HZ)
      : 30;
    return Math.min(0.5, (rateHz / STIM_RATE_HZ) * SENSORY_SCALE * (dt / (1 / 30)));
  };
  return { left: toStrength(leftMod), right: toStrength(rightMod) };
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
    .filter((n) => String(n.role ?? '').toLowerCase() === 'sensory')
    .map((n) => n.root_id);
  const sensoryLeftNeuronIds = connectome.neurons
    .filter((n) => String(n.role ?? '').toLowerCase() === 'sensory' && String(n.side ?? '').toLowerCase() === 'left')
    .map((n) => n.root_id);
  const sensoryRightNeuronIds = connectome.neurons
    .filter((n) => String(n.role ?? '').toLowerCase() === 'sensory' && String(n.side ?? '').toLowerCase() === 'right')
    .map((n) => n.root_id);
  const sensoryUnknownNeuronIds = connectome.neurons
    .filter((n) => String(n.role ?? '').toLowerCase() === 'sensory' && !['left', 'right'].includes(String(n.side ?? '').toLowerCase()))
    .map((n) => n.root_id);
  const pendingStimuli: { neurons: string[]; strength: number }[] = [];
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

    async function runRustStep(
      dt: number,
      pendingInput: Array<{ neuronIds: string[]; strength: number }>,
      includeActivity = true,
    ): Promise<{
      activitySparse: Record<string, number>;
      motorLeft: number;
      motorRight: number;
      motorFwd: number;
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
      };
      return socketClient.stepSim({
        simId,
        dt,
        includeActivity,
        fly: flyInput,
        // Use explicit lateralized pending stimulation below to encode odor geometry.
        sources: [],
        pending: pendingInput,
      });
    }

    async function step(dt: number, options?: { includeActivity?: boolean }): Promise<SimState> {
      const includeActivity = options?.includeActivity ?? true;
      const stepStart = performance.now();
      if (fly.dead) {
        const t = fly.t + dt;
        fly = { ...fly, t };
        const act = await runRustStep(dt, [], includeActivity);
        lastActivitySparse = act.activitySparse;
        lastInputActivity = undefined;
        lastEatenFoodId = undefined;
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
      const t = fly.t + dt;

      const toApply = pendingStimuli.splice(0, pendingStimuli.length);
      const pendingInput = toApply.map((p) => ({ neuronIds: p.neurons, strength: p.strength }));
      const lateral = includeActivity
        ? estimateLateralSensoryStrength(dt, fly, currentSources)
        : { left: 0, right: 0 };
      if (includeActivity) {
        if (lateral.left > 0) {
          const leftTargets = sensoryLeftNeuronIds.length > 0 ? sensoryLeftNeuronIds : sensoryNeuronIds;
          pendingInput.push({ neuronIds: leftTargets, strength: lateral.left });
        }
        if (lateral.right > 0) {
          const rightTargets = sensoryRightNeuronIds.length > 0 ? sensoryRightNeuronIds : sensoryNeuronIds;
          pendingInput.push({ neuronIds: rightTargets, strength: lateral.right });
        }
        if (sensoryUnknownNeuronIds.length > 0) {
          const centerStrength = Math.max(lateral.left, lateral.right) * 0.35;
          if (centerStrength > 0) pendingInput.push({ neuronIds: sensoryUnknownNeuronIds, strength: centerStrength });
        }
      }
      const inputActivityRec: Record<string, number> | undefined = includeActivity
        ? (() => {
            const out: Record<string, number> = {};
            if (lateral.left > 0) {
              const leftTargets = sensoryLeftNeuronIds.length > 0 ? sensoryLeftNeuronIds : sensoryNeuronIds;
              for (const id of leftTargets) out[id] = Math.max(out[id] ?? 0, lateral.left);
            }
            if (lateral.right > 0) {
              const rightTargets = sensoryRightNeuronIds.length > 0 ? sensoryRightNeuronIds : sensoryNeuronIds;
              for (const id of rightTargets) out[id] = Math.max(out[id] ?? 0, lateral.right);
            }
            if (sensoryUnknownNeuronIds.length > 0) {
              const centerStrength = Math.max(lateral.left, lateral.right) * 0.35;
              if (centerStrength > 0) {
                for (const id of sensoryUnknownNeuronIds) out[id] = Math.max(out[id] ?? 0, centerStrength);
              }
            }
            for (const p of pendingInput) {
              const v = Math.max(0.1, Math.min(1, Number(p.strength) || 0));
              for (const id of p.neuronIds) {
                if (!id) continue;
                out[id] = Math.max(out[id] ?? 0, v);
              }
            }
            return Object.keys(out).length > 0 ? out : undefined;
          })()
        : undefined;
      lastInputActivity = inputActivityRec;

      const rustStart = performance.now();
      const result = await runRustStep(dt, pendingInput, includeActivity);
      lastRustMs = Math.round(performance.now() - rustStart);
      lastSocketTiming = socketClient.getLastRequestTiming();
      lastRustTiming = {
        computeMs: result.computeMs,
        kernelMs: result.kernelMs,
        recurrentMs: result.recurrentMs,
        lifMs: result.lifMs,
        readoutMs: result.readoutMs,
      };
      const { activitySparse, motorLeft, motorRight, motorFwd } = result;
      lastActivitySparse = activitySparse;

      const turnFromMotor = (motorRight - motorLeft);
      const forwardFromMotor = motorLeft + motorRight + motorFwd;
      const motor = Math.tanh(forwardFromMotor) * 0.5;

      const onGround = fly.z < ON_GROUND_THRESH;
      const canFlyEat = (restTimeLeft > 0 || onGround || fly.z < 1.1) && fly.z < 1.2;
      let hunger = fly.hunger;
      let health = fly.health ?? 100;
      let isEating = false;
      let eatenFoodId: string | undefined;
      if (canFlyEat) {
        for (const s of currentSources) {
          if (Math.hypot(s.x - fly.x, s.y - fly.y) < EAT_RADIUS) {
            isEating = true;
            hunger = Math.min(100, hunger + FOOD_HUNGER_RESTORE);
            health = Math.min(100, health + FOOD_HEALTH_RESTORE);
            eatenFoodId = s.id;
            break;
          }
        }
      }
      const prevHunger = hunger;
      if (!isEating) hunger = Math.max(0, hunger - HUNGER_DECAY * dt);

      let timeAtZero = 0;
      if (hunger <= 0) {
        if (prevHunger <= 0) timeAtZero = dt;
        else timeAtZero = Math.max(0, HUNGER_DECAY * dt - prevHunger) / HUNGER_DECAY;
        health = Math.max(0, health - HEALTH_DECAY * timeAtZero);
        if (health <= 0) {
          fly = {
            ...fly,
            t,
            hunger,
            health: 0,
            dead: true,
            flyTimeLeft: Math.max(0, Math.min(1, flyTimeLeftSec / FLY_TIME_MAX)),
            restTimeLeft: restTimeLeft > 0 ? restTimeLeft : 0,
            restDuration: REST_TIME,
            feeding: false,
          };
          const activityRec = Object.keys(activitySparse).length ? activitySparse : undefined;
          lastEatenFoodId = eatenFoodId;
          lastJsMs = Math.round(performance.now() - stepStart - lastRustMs);
          return {
            t,
            fly,
            activity: activityRec,
            inputActivity: inputActivityRec,
            ...(eatenFoodId && { eatenFoodId }),
          };
        }
      }

      const hungry = hunger <= 90;
      let headingBias = turnFromMotor * dt;

      const nearRight = fly.x > ARENA - WALL_MARGIN;
      const nearLeft = fly.x < -ARENA + WALL_MARGIN;
      const nearTop = fly.y > ARENA - WALL_MARGIN;
      const nearBottom = fly.y < -ARENA + WALL_MARGIN;
      const nearCorner = (nearRight ? 1 : 0) + (nearLeft ? 1 : 0) + (nearTop ? 1 : 0) + (nearBottom ? 1 : 0) >= 2;
      if (nearCorner) {
        headingBias += angleToward(fly.heading, -fly.x, -fly.y) * 0.6 * dt;
      } else {
        if (nearRight) headingBias -= 0.2 * dt;
        if (nearLeft) headingBias += 0.2 * dt;
        if (nearTop) headingBias -= 0.2 * dt;
        if (nearBottom) headingBias += 0.2 * dt;
      }

      const BASELINE_EXPLORE = 0.03;
      let effectiveMotor = Math.max(motor, restTimeLeft <= 0 ? BASELINE_EXPLORE : 0);
      if (restTimeLeft > 0) {
        restTimeLeft -= dt;
        effectiveMotor = 0;
        if (restTimeLeft <= 0) flyTimeLeftSec = FLY_TIME_MAX;
      } else if (Math.abs(effectiveMotor) > 0.005) {
        flyTimeLeftSec = Math.max(0, flyTimeLeftSec - dt * Math.abs(effectiveMotor));
        if (flyTimeLeftSec <= 0) restTimeLeft = REST_TIME;
      } else {
        flyTimeLeftSec = Math.min(FLY_TIME_MAX, flyTimeLeftSec + dt * 0.5);
      }
      flyTimeLeftSec = Math.max(0, Math.min(FLY_TIME_MAX, flyTimeLeftSec));

      const MOVE_SPEED = 35;
      const dx = Math.cos(fly.heading) * effectiveMotor * dt * MOVE_SPEED;
      const dy = Math.sin(fly.heading) * effectiveMotor * dt * MOVE_SPEED;
      let nx = fly.x + (Number.isFinite(dx) ? dx : 0);
      let ny = fly.y + (Number.isFinite(dy) ? dy : 0);
      nx = Math.max(-ARENA, Math.min(ARENA, nx));
      ny = Math.max(-ARENA, Math.min(ARENA, ny));

      let zDrift = 0;
      if (restTimeLeft > 0) {
        zDrift = -0.5 * dt;
      } else {
        let nearFood = false;
        for (const s of currentSources) {
          if (s.type === 'food' && Math.hypot(s.x - fly.x, s.y - fly.y) < EAT_RADIUS * 2) {
            nearFood = true;
            break;
          }
        }
        if (hungry && nearFood) zDrift = -0.6 * dt;
        else if (Math.abs(effectiveMotor) > 0.005) zDrift = 0.4 * dt;
      }
      const zOsc = 0.08 * Math.sin(t * 20) * dt;
      let nz = fly.z + (Number.isFinite(zDrift) ? zDrift : 0) + (Number.isFinite(zOsc) ? zOsc : 0);
      nz = Math.max(GROUND_Z, Math.min(FLIGHT_Z, nz));

      let nHeading = fly.heading + (Number.isFinite(headingBias) ? headingBias : 0);
      const TWO_PI = 2 * Math.PI;
      nHeading = nHeading - TWO_PI * Math.floor((nHeading + Math.PI) / TWO_PI);
      nHeading = Number.isFinite(nHeading) ? nHeading : fly.heading;

      fly = {
        x: Number.isFinite(nx) ? nx : fly.x,
        y: Number.isFinite(ny) ? ny : fly.y,
        z: Number.isFinite(nz) ? nz : fly.z,
        heading: nHeading,
        t: Number.isFinite(t) ? t : fly.t,
        hunger: Number.isFinite(hunger) ? hunger : fly.hunger,
        health: Number.isFinite(health) ? health : (fly.health ?? 100),
        dead: false,
        flyTimeLeft: Math.max(0, Math.min(1, flyTimeLeftSec / FLY_TIME_MAX)),
        restTimeLeft: restTimeLeft > 0 ? restTimeLeft : 0,
        restDuration: REST_TIME,
        feeding: isEating,
      };

      const activityRec = Object.keys(activitySparse).length ? activitySparse : undefined;
      lastEatenFoodId = eatenFoodId;
      lastJsMs = Math.round(performance.now() - stepStart - lastRustMs);

      return {
        t,
        fly,
        activity: activityRec,
        inputActivity: inputActivityRec,
        ...(eatenFoodId && { eatenFoodId }),
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

    function inject(neurons: string[], strength = 0.8) {
      if (neurons.length > 0) pendingStimuli.push({ neurons, strength });
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
        ...(lastEatenFoodId && { eatenFoodId: lastEatenFoodId }),
      };
    }

    return {
      step,
      inject,
      getState,
      getTiming,
      neuronIds,
      isRustSim: true,
      isGpuSim: process.env.USE_CUDA === '1',
    };
  }
}

