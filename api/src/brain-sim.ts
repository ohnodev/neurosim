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
  /** id of food source consumed this step (API should remove it) */
  eatenFoodId?: string;
}

/** True if cell_type is a visual neuron (photoreceptor, motion, etc.). */
function isVisualCellType(cellType: string | undefined): boolean {
  if (!cellType?.trim()) return false;
  const t = cellType.trim();
  return (
    /^R[1-8](-6)?$/i.test(t) ||
    /^T[45][a-d]?$/i.test(t) ||
    /^L[1-5]?$/i.test(t) ||
    /^Dm\d*/i.test(t) ||
    /^Mi\d*/i.test(t) ||
    /^Tm\d*/i.test(t) ||
    /^M\d+/i.test(t) ||
    /^C[23]b?$/i.test(t) ||
    /^MeTu/i.test(t)
  );
}

/** Signed angle difference to turn from heading toward target (dx, dy), in [-PI, PI]. */
function angleToward(heading: number, dx: number, dy: number): number {
  const target = Math.atan2(dy, dx);
  let d = target - heading;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function createBrainSim(
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
  neuronIds.forEach((id, i) => {
    idToIdx.set(id, i);
  });

  const sensoryIndices: number[] = [];
  const visualIndices: number[] = [];
  const motorLeftIndices: number[] = [];
  const motorRightIndices: number[] = [];
  const motorUnknownIndices: number[] = [];
  for (let i = 0; i < neurons.length; i++) {
    const n = neurons[i];
    const r = n.role ?? 'interneuron';
    if (r === 'sensory') sensoryIndices.push(i);
    if (isVisualCellType(n.cell_type)) visualIndices.push(i);
    else if (r === 'motor') {
      const s = n.side ?? 'unknown';
      if (s === 'left') motorLeftIndices.push(i);
      else if (s === 'right') motorRightIndices.push(i);
      else motorUnknownIndices.push(i);
    }
  }
  const visualTargetIndices = visualIndices.length > 0 ? visualIndices : sensoryIndices;

  let activity = new Float32Array(neuronIds.length);
  const ARENA = 24;
  const WALL_MARGIN = 6;      // start turning away from walls when within this
  const SEEK_RADIUS = ARENA * 1.5; // steer toward food even when beyond source radius
  const HUNGER_DECAY = 0.8;   // per second when not eating
  const HEALTH_DECAY = 2.5;   // per second when hunger is 0 (fly survives ~40s at zero hunger)
  const FOOD_HUNGER_RESTORE = 50; // hunger restored when consuming one food (then it disappears)
  const FOOD_HEALTH_RESTORE = 50; // health restored when consuming one food

  function isAttractorType(type: string): boolean {
    return type === 'food' || type === 'light';
  }
  const FLY_TIME_MAX = 6;      // max seconds of continuous flight before fatigue
  const GROUND_Z = 0.35;
  const FLIGHT_Z = 1.5;
  const ON_GROUND_THRESH = 0.6; // z below this = on ground, can eat
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
  const pendingStimuli: { neurons: string[]; strength: number }[] = [];
  let flyTimeLeftSec = FLY_TIME_MAX;
  let restTimeLeft = 0;

  const REF_STEP = 1 / 30;    // reference timestep (API calls at 30Hz)
  const TAU = 0.004;          // propagation (minimal; no neuron stuck >0.42 for >5s)
  const DECAY = 0.975;        // per REF_STEP decay
  const PROP_CAP = 0.0004;    // max contribution per synapse
  const INPUT_RATE = 2;
  const SENSORY_SCALE = 0.14; // drive strength (reduced from 0.18 so activity can decay)
  const SENSORY_DUTY = 0.08;  // sensory bursts ~8% of time (sparse = time to turn off)
  const ACT_THRESHOLD = 0.08; // only report neurons above this (filters diffuse activity)

  function step(dt: number): SimState {
    if (fly.dead) {
      const t = fly.t + dt;
      fly = { ...fly, t };
      const actObj: Record<string, number> = {};
      neuronIds.forEach((id, i) => {
        const v = activity[i];
        if (v > ACT_THRESHOLD && Number.isFinite(v)) actObj[id] = Math.min(1, v);
      });
      return {
        t,
        fly,
        activity: Object.keys(actObj).length ? actObj : undefined,
      };
    }

    const currentSources = getSources();
    const t = fly.t + dt;
    const r = Math.max(0.1, Math.min(3, dt / REF_STEP)); // scale factor; clamp to avoid extremes
    const decayFactor = Math.pow(DECAY, r);
    const nextActivity = new Float32Array(activity.length);

    // Decay + propagate (dt-scaled for frame-rate independence)
    for (let i = 0; i < activity.length; i++) {
      nextActivity[i] = activity[i] * decayFactor;
    }

    const tauR = TAU * r;
    const propCapR = PROP_CAP * r;
    for (let i = 0; i < neuronIds.length; i++) {
      const preId = neuronIds[i];
      const list = adj.get(preId) ?? [];
      for (const { post, weight } of list) {
        const j = idToIdx.get(post);
        if (j != null) {
          const v = Math.min(activity[i] * tauR * Math.min(weight, 10), propCapR);
          nextActivity[j] += Number.isFinite(v) ? v : 0;
        }
      }
    }

    // Route visual stimuli (food/light) into visual-type neurons. Pulsed; rotate which neurons
    // receive input so none stay on >5s (each gets input ~1/N of the time).
    if (visualTargetIndices.length > 0) {
      const pulse = Math.sin(t * INPUT_RATE) > 1 - SENSORY_DUTY * 2 ? 1 : 0;
      if (pulse > 0) {
        let foodSignal = 0;
        let lightSignal = 0;
        for (const s of currentSources) {
          const dist = Math.hypot(s.x - fly.x, s.y - fly.y);
          if (dist < 1) continue;
          const invDist = 1 / (1 + dist * 0.1);
          if (s.type === 'food') foodSignal += invDist * (1 - fly.hunger / 100);
          else if (s.type === 'light') lightSignal += invDist * 0.3;
        }
        const baseNoise = 0.08 * (0.5 + 0.5 * Math.sin(t * INPUT_RATE));
        const n = visualTargetIndices.length;
        // For large connectomes: rotate so each neuron gets input ~1/30 of time (5+ sec gaps)
        const useChunks = n >= 20;
        let start = 0, end = n;
        if (useChunks) {
          const chunkSize = Math.max(1, Math.floor(n / 30));
          const stepIdx = Math.floor(t / REF_STEP);
          const chunk = stepIdx % Math.max(1, Math.ceil(n / chunkSize));
          start = chunk * chunkSize;
          end = Math.min(start + chunkSize, n);
        }
        const activeCount = end - start;
        const rawPerNeuron = (baseNoise + foodSignal * 0.5 + lightSignal) / Math.max(1, activeCount);
        const perNeuron = Math.min(rawPerNeuron * SENSORY_SCALE * r, 0.5);
        for (let k = start; k < end; k++) {
          nextActivity[visualTargetIndices[k]] += perNeuron;
        }
      }
    }

    // Apply pending stimuli (inject into specified neurons)
    while (pendingStimuli.length > 0) {
      const { neurons, strength } = pendingStimuli.shift()!;
      for (const id of neurons) {
        const idx = idToIdx.get(id);
        if (idx != null) nextActivity[idx] += Math.min(strength, 2);
      }
    }

    // Clamp activity (0.5 = more dynamic range, avoids all-at-1 saturation)
    const ACTIVITY_MAX = 0.5;
    for (let i = 0; i < nextActivity.length; i++) {
      nextActivity[i] = Math.max(0, Math.min(ACTIVITY_MAX, Number.isFinite(nextActivity[i]) ? nextActivity[i] : 0));
    }
    // During rest: shut down all neurons (gives network a chance to reset, prevents stuck-on neurons)
    if (restTimeLeft > 0) {
      nextActivity.fill(0);
    }
    activity = nextActivity;

    // Read motor output from motor-type neurons only (classification-based, not scalar)
    const motorScale = 0.002;
    let motorLeft = 0, motorRight = 0, motorFwd = 0;
    for (const i of motorLeftIndices) motorLeft += activity[i];
    for (const i of motorRightIndices) motorRight += activity[i];
    for (const i of motorUnknownIndices) motorFwd += activity[i];
    const turnFromMotor = (motorRight - motorLeft) * motorScale;
    const forwardFromMotor = (motorLeft + motorRight + motorFwd) * motorScale;
    const motor = Math.tanh(forwardFromMotor) * 0.5;

    // Hunger: allow eating when (a) resting or on ground, or (b) flying low (z < 1.1). At z ∈ [1.1, 1.2)
    // only resting/on-ground flies can eat; above z >= 1.2 never (prevents eating while hovering high).
    const onGround = fly.z < ON_GROUND_THRESH;
    const canFlyEat = (restTimeLeft > 0 || onGround || fly.z < 1.1) && fly.z < 1.2;
    let hunger = fly.hunger;
    let health = fly.health ?? 100;
    let isEating = false;
    let eatenFoodId: string | undefined;
    if (canFlyEat) {
      for (const s of currentSources) {
        if (s.type !== 'food') continue;
        const dist = Math.hypot(s.x - fly.x, s.y - fly.y);
        if (dist < EAT_RADIUS) {
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
      if (prevHunger <= 0) {
        timeAtZero = dt;
      } else {
        const overflow = Math.max(0, HUNGER_DECAY * dt - prevHunger);
        timeAtZero = overflow / HUNGER_DECAY;
      }
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
        const actObj: Record<string, number> = {};
        neuronIds.forEach((id, i) => {
          const v = activity[i];
          if (v > ACT_THRESHOLD && Number.isFinite(v)) actObj[id] = Math.min(1, v);
        });
        return {
          t,
          fly,
          activity: Object.keys(actObj).length ? actObj : undefined,
          ...(eatenFoodId && { eatenFoodId }),
        };
      }
    }

    // Hungry (low hunger): steer toward food. Full (high hunger): explore. Min 0.25 drive when hungry.
    const hungry = hunger <= 90;
    const full = hunger > 90;
    const foodResponsiveness = hungry ? Math.max(0.25, (90 - hunger) / 90) : 0;

    let headingBias = turnFromMotor * dt + 0.1 * Math.sin(t * 0.7) * dt;

    // Wall avoidance: turn away when near arena boundary (prevents flying into corners)
    const nearRight = fly.x > ARENA - WALL_MARGIN;
    const nearLeft = fly.x < -ARENA + WALL_MARGIN;
    const nearTop = fly.y > ARENA - WALL_MARGIN;
    const nearBottom = fly.y < -ARENA + WALL_MARGIN;
    if (nearRight) headingBias -= 0.6 * dt;   // turn away from right wall
    if (nearLeft) headingBias += 0.6 * dt;
    if (nearTop) headingBias -= 0.5 * dt;     // turn away from top
    if (nearBottom) headingBias += 0.5 * dt;

    if (hungry && currentSources.length > 0) {
      let nearestDist = Infinity;
      let nearestDx = 0;
      let nearestDy = 0;
      let nearestWeight = 1;
      for (const s of currentSources) {
        if (!isAttractorType(s.type)) continue;
        const dx = s.x - fly.x;
        const dy = s.y - fly.y;
        const dist = Math.hypot(dx, dy);
        const weight = s.type === 'food' ? 1 : 0.6;
        const inRange = dist < Math.max(s.radius, SEEK_RADIUS) && dist > 0.5;
        if (inRange && dist < nearestDist) {
          nearestDist = dist;
          nearestDx = dx;
          nearestDy = dy;
          nearestWeight = weight;
        }
      }
      if (nearestDist < Infinity) {
        const turn = angleToward(fly.heading, nearestDx, nearestDy);
        headingBias += turn * 3.8 * foodResponsiveness * nearestWeight * dt;
      } else {
        // Hungry but no attractor in range: search behavior (stronger wandering)
        headingBias += 0.25 * Math.sin(t * 0.8) * dt + 0.12 * Math.sin(t * 1.5) * dt;
      }
    } else if (full) {
      // Explore mode: light random wandering when full
      headingBias += 0.15 * Math.sin(t * 0.5) * dt + 0.08 * Math.sin(t * 1.3) * dt;
    }

    // Fatigue: fly time drains when moving. When flyTimeLeft hits 0 -> land and rest.
    const moveResponsiveness = hungry ? foodResponsiveness : full ? 0.4 : 0;
    const BASELINE_EXPLORE = 0.12; // minimum drive when not resting so fly always moves
    let effectiveMotor = Math.max(motor * moveResponsiveness, restTimeLeft <= 0 ? BASELINE_EXPLORE : 0);
    if (restTimeLeft > 0) {
      restTimeLeft -= dt;
      effectiveMotor = 0;
      if (restTimeLeft <= 0) flyTimeLeftSec = FLY_TIME_MAX;
    } else if (Math.abs(effectiveMotor) > 0.005) {
      flyTimeLeftSec = Math.max(0, flyTimeLeftSec - dt * Math.abs(effectiveMotor));
      if (flyTimeLeftSec <= 0) {
        restTimeLeft = REST_TIME; // fatigued -> land and rest
      }
    } else {
      flyTimeLeftSec = Math.min(FLY_TIME_MAX, flyTimeLeftSec + dt * 0.5); // recover a bit when idle
    }
    flyTimeLeftSec = Math.max(0, Math.min(FLY_TIME_MAX, flyTimeLeftSec));

    const MOVE_SPEED = 35; // units/sec at full motor
    const dx = Math.cos(fly.heading) * effectiveMotor * dt * MOVE_SPEED;
    const dy = Math.sin(fly.heading) * effectiveMotor * dt * MOVE_SPEED;
    let nx = fly.x + (Number.isFinite(dx) ? dx : 0);
    let ny = fly.y + (Number.isFinite(dy) ? dy : 0);
    nx = Math.max(-ARENA, Math.min(ARENA, nx));
    ny = Math.max(-ARENA, Math.min(ARENA, ny));

    // z: descend when resting or when hungry+near food (land to feed); rise when flying
    let zDrift = 0;
    if (restTimeLeft > 0) {
      zDrift = -0.5 * dt; // land while resting
    } else {
      let nearFood = false;
      for (const s of currentSources) {
        if (s.type !== 'food') continue;
        if (Math.hypot(s.x - fly.x, s.y - fly.y) < EAT_RADIUS * 2) {
          nearFood = true;
          break;
        }
      }
      if (hungry && nearFood) {
        zDrift = -0.6 * dt; // descend to land and feed
      } else if (Math.abs(effectiveMotor) > 0.005) {
        zDrift = 0.4 * dt; // rise when flying (hungry or explore)
      }
    }
    const zOsc = 0.08 * Math.sin(t * 20) * dt;
    let nz = fly.z + (Number.isFinite(zDrift) ? zDrift : 0) + (Number.isFinite(zOsc) ? zOsc : 0);
    nz = Math.max(GROUND_Z, Math.min(FLIGHT_Z, nz));

    let nHeading = fly.heading + (Number.isFinite(headingBias) ? headingBias : 0);
    const TWO_PI = 2 * Math.PI;
    nHeading = nHeading - TWO_PI * Math.floor((nHeading + Math.PI) / TWO_PI); // normalize to (-π, π]
    nHeading = Number.isFinite(nHeading) ? nHeading : fly.heading;
    fly = {
      x: Number.isFinite(nx) ? nx : fly.x,
      y: Number.isFinite(ny) ? ny : fly.y,
      z: Number.isFinite(nz) ? nz : fly.z,
      heading: Number.isFinite(nHeading) ? nHeading : fly.heading,
      t: Number.isFinite(t) ? t : fly.t,
      hunger: Number.isFinite(hunger) ? hunger : fly.hunger,
      health: Number.isFinite(health) ? health : (fly.health ?? 100),
      dead: false,
      flyTimeLeft: Math.max(0, Math.min(1, flyTimeLeftSec / FLY_TIME_MAX)),
      restTimeLeft: restTimeLeft > 0 ? restTimeLeft : 0,
      restDuration: REST_TIME,
      feeding: isEating,
    };

    const actObj: Record<string, number> = {};
    neuronIds.forEach((id, i) => {
      const v = activity[i];
      if (v > ACT_THRESHOLD && Number.isFinite(v)) actObj[id] = Math.min(1, v);
    });

    return {
      t,
      fly,
      activity: Object.keys(actObj).length ? actObj : undefined,
      ...(eatenFoodId && { eatenFoodId }),
    };
  }

  function inject(neurons: string[], strength = 0.8) {
    if (neurons.length > 0) pendingStimuli.push({ neurons, strength });
  }

  function getState(): SimState {
    const actObj: Record<string, number> = {};
    neuronIds.forEach((id, i) => {
      const v = activity[i];
      if (v > ACT_THRESHOLD && Number.isFinite(v)) actObj[id] = Math.min(1, v);
    });
    const flyWithMeta = {
      ...fly,
      health: fly.health ?? 100,
      dead: fly.dead ?? false,
      flyTimeLeft: Math.max(0, Math.min(1, flyTimeLeftSec / FLY_TIME_MAX)),
      restTimeLeft: restTimeLeft > 0 ? restTimeLeft : 0,
      restDuration: REST_TIME,
      feeding: fly.feeding ?? false,
    };
    return { t: fly.t, fly: flyWithMeta, activity: Object.keys(actObj).length ? actObj : undefined };
  }

  return { step, inject, getState, neuronIds };
}
