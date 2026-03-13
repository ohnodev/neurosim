import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

import type { Connectome, Neuron } from './connectome.js';
import { buildAdjacency } from './connectome.js';
import type { FlyState } from './fly-state.js';
import type { WorldSource } from './world.js';

export type { FlyState } from './fly-state.js';
export const EAT_RADIUS = 2.5;
export const REST_TIME = 4;

export interface SimState {
  t: number;
  fly: FlyState;
  activity?: Record<string, number>;
  eatenFoodId?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type RustBrainSimCtor = new (
  neuronIds: string[],
  connections: Array<{ pre: string; post: string; weight?: number }>,
  sensoryIndices: number[],
  motorLeft: number[],
  motorRight: number[],
  motorUnknown: number[],
) => {
  getActivity: () => Float32Array;
  step: (
    dt: number,
    fly: { x: number; y: number; z: number; heading: number; t: number; hunger: number; health: number; restTimeLeft: number },
    sources: Array<{ x: number; y: number; radius: number }>,
    pending: Array<{ neuronIds: string[]; strength: number }>,
  ) => { activity: Float32Array; motorLeft: number; motorRight: number; motorFwd: number };
};

let BrainSimRust: RustBrainSimCtor | null = null;

if (process.env.USE_RUST_SIM !== '0') {
  try {
    const require = createRequire(import.meta.url);
    const mod = require(path.join(__dirname, '..', 'brain-sim-rs'));
    BrainSimRust = mod.BrainSim ?? null;
  } catch {
    BrainSimRust = null;
  }
}

const SUGAR_GRN_IDS = [
  '720575940624963786', '720575940630233916', '720575940637568838', '720575940638202345',
  '720575940617000768', '720575940630797113', '720575940632889389', '720575940621754367',
  '720575940621502051', '720575940640649691', '720575940639332736', '720575940616885538',
  '720575940639198653', '720575940639259967', '720575940617937543', '720575940632425919',
  '720575940633143833', '720575940612670570', '720575940628853239', '720575940629176663',
  '720575940611875570',
];

function isPhotoreceptorCellType(cellType: string | undefined): boolean {
  if (!cellType?.trim()) return false;
  return /^R[1-8](-6)?$/i.test(cellType.trim());
}

function angleToward(heading: number, dx: number, dy: number): number {
  const target = Math.atan2(dy, dx);
  let d = target - heading;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

const ARENA = 24;
const WALL_MARGIN = 6;
const SEEK_RADIUS = ARENA * 1.5;
const HUNGER_DECAY = 0.8;
const HEALTH_DECAY = 2.5;
const FOOD_HUNGER_RESTORE = 50;
const FOOD_HEALTH_RESTORE = 50;
const FLY_TIME_MAX = 6;
const GROUND_Z = 0.35;
const FLIGHT_Z = 1.5;
const ON_GROUND_THRESH = 0.6;
const ACT_THRESHOLD = 0.08;

function activityToRecord(activity: Float32Array | undefined | null, neuronIds: string[]): Record<string, number> | undefined {
  if (!activity || typeof activity.length !== 'number') return undefined;
  const actObj: Record<string, number> = {};
  for (let i = 0; i < neuronIds.length; i++) {
    const v = activity[i];
    if (v > ACT_THRESHOLD && Number.isFinite(v)) actObj[neuronIds[i]] = Math.min(1, v);
  }
  return Object.keys(actObj).length ? actObj : undefined;
}

export function createBrainSim(
  connectome: Connectome,
  worldSources: WorldSource[] | (() => WorldSource[]) = [],
  initialFlyState?: Partial<FlyState>,
) {
  const getSources = (): WorldSource[] =>
    typeof worldSources === 'function' ? worldSources() : worldSources;
  const neurons: Neuron[] = connectome.neurons;
  const neuronIds = neurons.map((n) => n.root_id);

  const sensoryIndices: number[] = [];
  const afferentVisualIndices: number[] = [];
  const sugarGrnIndices: number[] = [];
  const motorLeftIndices: number[] = [];
  const motorRightIndices: number[] = [];
  const motorUnknownIndices: number[] = [];
  for (let i = 0; i < neurons.length; i++) {
    const n = neurons[i];
    const r = n.role ?? 'interneuron';
    if (SUGAR_GRN_IDS.includes(n.root_id)) sugarGrnIndices.push(i);
    if (r === 'sensory') {
      sensoryIndices.push(i);
      if (isPhotoreceptorCellType(n.cell_type)) afferentVisualIndices.push(i);
    } else if (r === 'motor') {
      const s = n.side ?? 'unknown';
      if (s === 'left') motorLeftIndices.push(i);
      else if (s === 'right') motorRightIndices.push(i);
      else motorUnknownIndices.push(i);
    }
  }
  const sensoryTargetIndices =
    sugarGrnIndices.length > 0
      ? sugarGrnIndices
      : afferentVisualIndices.length > 0
        ? afferentVisualIndices
        : sensoryIndices;

  const connectionsForRust = connectome.connections.map((c) => ({
    pre: c.pre,
    post: c.post,
    weight: c.weight,
  }));

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

  let rustCore: InstanceType<NonNullable<typeof BrainSimRust>> | null = null;
  if (BrainSimRust) {
    try {
      rustCore = new BrainSimRust(
        neuronIds,
        connectionsForRust,
        sensoryTargetIndices,
        motorLeftIndices,
        motorRightIndices,
        motorUnknownIndices,
      );
    } catch {
      rustCore = null;
    }
  }

  if (rustCore) {
    function step(dt: number): SimState {
      if (fly.dead) {
        const t = fly.t + dt;
        fly = { ...fly, t };
        const act = rustCore!.step(dt, { x: fly.x, y: fly.y, z: fly.z, heading: fly.heading, t: fly.t, hunger: fly.hunger, health: fly.health ?? 100, restTimeLeft }, [], []);
        return { t, fly, activity: activityToRecord(act.activity, neuronIds) };
      }

      const currentSources = getSources();
      const t = fly.t + dt;

      const toApply = pendingStimuli.splice(0, pendingStimuli.length);
      const pendingInput = toApply.map((p) => ({ neuronIds: p.neurons, strength: p.strength }));

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
      const sourcesInput = currentSources.map((s) => ({ x: s.x, y: s.y, radius: s.radius }));

      const result = rustCore!.step(dt, flyInput, sourcesInput, pendingInput);
      const { activity, motorLeft, motorRight, motorFwd } = result;

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
          return { t, fly, activity: activityToRecord(activity, neuronIds), ...(eatenFoodId && { eatenFoodId }) };
        }
      }

      const hungry = hunger <= 90;
      const full = hunger > 90;
      const foodResponsiveness = hungry ? Math.max(0.25, (90 - hunger) / 90) : 0;

      let headingBias = turnFromMotor * dt + 0.1 * Math.sin(t * 0.7) * dt;

      const nearRight = fly.x > ARENA - WALL_MARGIN;
      const nearLeft = fly.x < -ARENA + WALL_MARGIN;
      const nearTop = fly.y > ARENA - WALL_MARGIN;
      const nearBottom = fly.y < -ARENA + WALL_MARGIN;
      const nearCorner = (nearRight ? 1 : 0) + (nearLeft ? 1 : 0) + (nearTop ? 1 : 0) + (nearBottom ? 1 : 0) >= 2;
      if (nearCorner) {
        headingBias += angleToward(fly.heading, -fly.x, -fly.y) * 2.2 * dt;
      } else {
        if (nearRight) headingBias -= 0.6 * dt;
        if (nearLeft) headingBias += 0.6 * dt;
        if (nearTop) headingBias -= 0.5 * dt;
        if (nearBottom) headingBias += 0.5 * dt;
      }

      if (hungry && currentSources.length > 0) {
        let nearestDist = Infinity;
        let nearestDx = 0, nearestDy = 0, nearestWeight = 1;
        for (const s of currentSources) {
          const dx = s.x - fly.x, dy = s.y - fly.y;
          const dist = Math.hypot(dx, dy);
          const inRange = dist < Math.max(s.radius, SEEK_RADIUS) && dist > 0.5;
          if (inRange && dist < nearestDist) {
            nearestDist = dist;
            nearestDx = dx;
            nearestDy = dy;
            nearestWeight = 1;
          }
        }
        if (nearestDist < Infinity) {
          headingBias += angleToward(fly.heading, nearestDx, nearestDy) * 3.8 * foodResponsiveness * nearestWeight * dt;
        } else {
          headingBias += 0.25 * Math.sin(t * 0.8) * dt + 0.12 * Math.sin(t * 1.5) * dt;
        }
      } else if (full) {
        headingBias += 0.15 * Math.sin(t * 0.5) * dt + 0.08 * Math.sin(t * 1.3) * dt;
      }

      const moveResponsiveness = hungry ? foodResponsiveness : full ? 0.4 : 0;
      const BASELINE_EXPLORE = 0.12;
      let effectiveMotor = Math.max(motor * moveResponsiveness, restTimeLeft <= 0 ? BASELINE_EXPLORE : 0);
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

      return {
        t,
        fly,
        activity: activityToRecord(activity, neuronIds),
        ...(eatenFoodId && { eatenFoodId }),
      };
    }

    function inject(neurons: string[], strength = 0.8) {
      if (neurons.length > 0) pendingStimuli.push({ neurons, strength });
    }

    function getState(): SimState {
      let act: Float32Array | undefined;
      try {
        act = rustCore!.getActivity();
      } catch {
        act = undefined;
      }
      const flyWithMeta = {
        ...fly,
        health: fly.health ?? 100,
        dead: fly.dead ?? false,
        flyTimeLeft: Math.max(0, Math.min(1, flyTimeLeftSec / FLY_TIME_MAX)),
        restTimeLeft: restTimeLeft > 0 ? restTimeLeft : 0,
        restDuration: REST_TIME,
        feeding: fly.feeding ?? false,
      };
      return { t: fly.t, fly: flyWithMeta, activity: activityToRecord(act, neuronIds) };
    }

    return { step, inject, getState, neuronIds, isRustSim: true };
  }

  return { ...createBrainSimTS(connectome, worldSources, initialFlyState), isRustSim: false };
}

function createBrainSimTS(
  connectome: Connectome,
  worldSources: WorldSource[] | (() => WorldSource[]) = [],
  initialFlyState?: Partial<FlyState>,
) {
  const getSources = (): WorldSource[] =>
    typeof worldSources === 'function' ? worldSources() : worldSources;
  const adj = buildAdjacency(connectome.connections);
  const neurons: Neuron[] = connectome.neurons;
  const neuronIds = neurons.map((n) => n.root_id);
  const idToIdx = new Map<string, number>();
  neuronIds.forEach((id, i) => idToIdx.set(id, i));

  const sensoryIndices: number[] = [];
  const afferentVisualIndices: number[] = [];
  const sugarGrnIndices: number[] = [];
  const motorLeftIndices: number[] = [];
  const motorRightIndices: number[] = [];
  const motorUnknownIndices: number[] = [];
  for (let i = 0; i < neurons.length; i++) {
    const n = neurons[i];
    const r = n.role ?? 'interneuron';
    if (SUGAR_GRN_IDS.includes(n.root_id)) sugarGrnIndices.push(i);
    if (r === 'sensory') {
      sensoryIndices.push(i);
      if (isPhotoreceptorCellType(n.cell_type)) afferentVisualIndices.push(i);
    } else if (r === 'motor') {
      const s = n.side ?? 'unknown';
      if (s === 'left') motorLeftIndices.push(i);
      else if (s === 'right') motorRightIndices.push(i);
      else motorUnknownIndices.push(i);
    }
  }
  const sensoryTargetIndices =
    sugarGrnIndices.length > 0 ? sugarGrnIndices : afferentVisualIndices.length > 0 ? afferentVisualIndices : sensoryIndices;

  let activity = new Float32Array(neuronIds.length);
  let fly: FlyState = {
    x: 0, y: 0, z: GROUND_Z, heading: 0, t: 0, hunger: 100, health: 100,
    ...initialFlyState,
  };
  const pendingStimuli: { neurons: string[]; strength: number }[] = [];
  let flyTimeLeftSec = FLY_TIME_MAX;
  let restTimeLeft = 0;

  const REF_STEP = 1 / 30;
  const TAU = 0.004;
  const DECAY = 0.975;
  const PROP_CAP = 0.0004;
  const STIM_RATE_HZ = 200;
  const SENSORY_SCALE = 0.18;

  function step(dt: number): SimState {
    if (fly.dead) {
      const t = fly.t + dt;
      fly = { ...fly, t };
      return { t, fly, activity: activityToRecord(activity, neuronIds) };
    }

    const currentSources = getSources();
    const t = fly.t + dt;
    const r = Math.max(0.1, Math.min(3, dt / REF_STEP));
    const decayFactor = Math.pow(DECAY, r);
    const nextActivity = new Float32Array(activity.length);

    for (let i = 0; i < activity.length; i++) nextActivity[i] = activity[i] * decayFactor;
    const tauR = TAU * r;
    const propCapR = PROP_CAP * r;
    for (let i = 0; i < neuronIds.length; i++) {
      const list = adj.get(neuronIds[i]) ?? [];
      for (const { post, weight } of list) {
        const j = idToIdx.get(post);
        if (j != null) {
          const v = Math.min(activity[i] * tauR * Math.min(weight, 10), propCapR);
          nextActivity[j] += Number.isFinite(v) ? v : 0;
        }
      }
    }

    if (sensoryTargetIndices.length > 0) {
      let rateHz = 50;
      const hungry = fly.hunger <= 90;
      const full = fly.hunger > 90;
      let foodModulation = 0;
      for (const s of currentSources) {
        const dist = Math.hypot(s.x - fly.x, s.y - fly.y);
        if (dist < 1) continue;
        foodModulation += (1 / (1 + dist * 0.1)) * (1 - fly.hunger / 100);
      }
      if (hungry && foodModulation > 0) rateHz = Math.min(STIM_RATE_HZ, 50 + foodModulation * STIM_RATE_HZ);
      else if (full) rateHz = 30;
      const perNeuron = Math.min((rateHz / STIM_RATE_HZ) * SENSORY_SCALE * r, 0.5);
      for (const k of sensoryTargetIndices) nextActivity[k] += perNeuron;
    }

    while (pendingStimuli.length > 0) {
      const { neurons: ids, strength } = pendingStimuli.shift()!;
      for (const id of ids) {
        const idx = idToIdx.get(id);
        if (idx != null) nextActivity[idx] += Math.min(strength, 2);
      }
    }

    const ACTIVITY_MAX = 0.5;
    for (let i = 0; i < nextActivity.length; i++) {
      nextActivity[i] = Math.max(0, Math.min(ACTIVITY_MAX, Number.isFinite(nextActivity[i]) ? nextActivity[i] : 0));
    }
    if (restTimeLeft > 0) nextActivity.fill(0);
    activity = nextActivity;

    const motorScale = 0.002;
    let motorLeft = 0, motorRight = 0, motorFwd = 0;
    for (const i of motorLeftIndices) motorLeft += activity[i];
    for (const i of motorRightIndices) motorRight += activity[i];
    for (const i of motorUnknownIndices) motorFwd += activity[i];
    const turnFromMotor = (motorRight - motorLeft) * motorScale;
    const forwardFromMotor = (motorLeft + motorRight + motorFwd) * motorScale;
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
          ...fly, t, hunger, health: 0, dead: true,
          flyTimeLeft: Math.max(0, Math.min(1, flyTimeLeftSec / FLY_TIME_MAX)),
          restTimeLeft: restTimeLeft > 0 ? restTimeLeft : 0,
          restDuration: REST_TIME, feeding: false,
        };
        return { t, fly, activity: activityToRecord(activity, neuronIds), ...(eatenFoodId && { eatenFoodId }) };
      }
    }

    const hungry = hunger <= 90;
    const full = hunger > 90;
    const foodResponsiveness = hungry ? Math.max(0.25, (90 - hunger) / 90) : 0;
    let headingBias = turnFromMotor * dt + 0.1 * Math.sin(t * 0.7) * dt;

    const nearRight = fly.x > ARENA - WALL_MARGIN;
    const nearLeft = fly.x < -ARENA + WALL_MARGIN;
    const nearTop = fly.y > ARENA - WALL_MARGIN;
    const nearBottom = fly.y < -ARENA + WALL_MARGIN;
    const nearCorner = [nearRight, nearLeft, nearTop, nearBottom].filter(Boolean).length >= 2;
    if (nearCorner) headingBias += angleToward(fly.heading, -fly.x, -fly.y) * 2.2 * dt;
    else {
      if (nearRight) headingBias -= 0.6 * dt;
      if (nearLeft) headingBias += 0.6 * dt;
      if (nearTop) headingBias -= 0.5 * dt;
      if (nearBottom) headingBias += 0.5 * dt;
    }

    if (hungry && currentSources.length > 0) {
      let nearestDist = Infinity;
      let nearestDx = 0, nearestDy = 0, nearestWeight = 1;
      for (const s of currentSources) {
        const dx = s.x - fly.x, dy = s.y - fly.y;
        const dist = Math.hypot(dx, dy);
        const inRange = dist < Math.max(s.radius, SEEK_RADIUS) && dist > 0.5;
        if (inRange && dist < nearestDist) {
          nearestDist = dist;
          nearestDx = dx;
          nearestDy = dy;
          nearestWeight = 1;
        }
      }
      if (nearestDist < Infinity) {
        headingBias += angleToward(fly.heading, nearestDx, nearestDy) * 3.8 * foodResponsiveness * nearestWeight * dt;
      } else {
        headingBias += 0.25 * Math.sin(t * 0.8) * dt + 0.12 * Math.sin(t * 1.5) * dt;
      }
    } else if (full) {
      headingBias += 0.15 * Math.sin(t * 0.5) * dt + 0.08 * Math.sin(t * 1.3) * dt;
    }

    const moveResponsiveness = hungry ? foodResponsiveness : full ? 0.4 : 0;
    const BASELINE_EXPLORE = 0.12;
    let effectiveMotor = Math.max(motor * moveResponsiveness, restTimeLeft <= 0 ? BASELINE_EXPLORE : 0);
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
    const dxx = Math.cos(fly.heading) * effectiveMotor * dt * MOVE_SPEED;
    const dyy = Math.sin(fly.heading) * effectiveMotor * dt * MOVE_SPEED;
    let nx = fly.x + (Number.isFinite(dxx) ? dxx : 0);
    let ny = fly.y + (Number.isFinite(dyy) ? dyy : 0);
    nx = Math.max(-ARENA, Math.min(ARENA, nx));
    ny = Math.max(-ARENA, Math.min(ARENA, ny));

    let zDrift = 0;
    if (restTimeLeft > 0) zDrift = -0.5 * dt;
    else {
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
    nHeading = nHeading - 2 * Math.PI * Math.floor((nHeading + Math.PI) / (2 * Math.PI));
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

    return {
      t,
      fly,
      activity: activityToRecord(activity, neuronIds),
      ...(eatenFoodId && { eatenFoodId }),
    };
  }

  function inject(neurons: string[], strength = 0.8) {
    if (neurons.length > 0) pendingStimuli.push({ neurons, strength });
  }

  function getState(): SimState {
    const flyWithMeta = {
      ...fly,
      health: fly.health ?? 100,
      dead: fly.dead ?? false,
      flyTimeLeft: Math.max(0, Math.min(1, flyTimeLeftSec / FLY_TIME_MAX)),
      restTimeLeft: restTimeLeft > 0 ? restTimeLeft : 0,
      restDuration: REST_TIME,
      feeding: fly.feeding ?? false,
    };
    return { t: fly.t, fly: flyWithMeta, activity: activityToRecord(activity, neuronIds) };
  }

  return { step, inject, getState, neuronIds };
}
