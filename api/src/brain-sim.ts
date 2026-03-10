import type { Connectome, Neuron } from './connectome.js';
import { buildAdjacency } from './connectome.js';
import type { WorldSource } from './world.js';

export interface FlyState {
  x: number;
  y: number;
  z: number;
  heading: number;
  t: number;
  hunger: number;
}

export interface SimState {
  t: number;
  fly: FlyState;
  activity?: Record<string, number>;
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

export function createBrainSim(connectome: Connectome, worldSources: WorldSource[] = []) {
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
  const EAT_RADIUS = 1.5;
  const HUNGER_DECAY = 1;   // per second
  const EAT_RATE = 15;      // per second when eating

  function isAttractorType(type: string): boolean {
    return type === 'food' || type === 'light';
  }
  const FLY_TIME_MAX = 5;      // max seconds of continuous flight
  const GROUND_Z = 0.35;
  const FLIGHT_Z = 1.5;
  let fly: FlyState = { x: 0, y: 0, z: GROUND_Z, heading: 0, t: 0, hunger: 100 };
  const pendingStimuli: { neurons: string[]; strength: number }[] = [];
  let flyTimeLeft = FLY_TIME_MAX;
  let restTimeLeft = 0;

  const TAU = 0.05;
  const DECAY = 0.9;
  const INPUT_RATE = 2;

  function step(dt: number): SimState {
    const t = fly.t + dt;
    const nextActivity = new Float32Array(activity.length);

    // Decay + propagate
    for (let i = 0; i < activity.length; i++) {
      nextActivity[i] = activity[i] * DECAY;
    }

    for (let i = 0; i < neuronIds.length; i++) {
      const preId = neuronIds[i];
      const list = adj.get(preId) ?? [];
      for (const { post, weight } of list) {
        const j = idToIdx.get(post);
        if (j != null) {
          const v = activity[i] * TAU * Math.min(weight, 10);
          nextActivity[j] += Number.isFinite(v) ? v : 0;
        }
      }
    }

    // Route visual stimuli (food/light) into visual-type neurons (R1-6, T4, T5, L*, Dm*, etc.)
    if (visualTargetIndices.length > 0) {
      let foodSignal = 0;
      let lightSignal = 0;
      for (const s of worldSources) {
        const dist = Math.hypot(s.x - fly.x, s.y - fly.y);
        if (dist < 1) continue;
        const invDist = 1 / (1 + dist * 0.1);
        if (s.type === 'food') foodSignal += invDist * (1 - fly.hunger / 100);
        else if (s.type === 'light') lightSignal += invDist * 0.3;
      }
      const baseNoise = 0.15 * (0.5 + 0.5 * Math.sin(t * INPUT_RATE));
      const perNeuron = (baseNoise + foodSignal * 0.5 + lightSignal) / visualTargetIndices.length;
      for (const idx of visualTargetIndices) {
        nextActivity[idx] += Math.min(perNeuron, 0.8);
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

    // Clamp activity to prevent numerical explosion
    const ACTIVITY_MAX = 1;
    for (let i = 0; i < nextActivity.length; i++) {
      nextActivity[i] = Math.max(0, Math.min(ACTIVITY_MAX, Number.isFinite(nextActivity[i]) ? nextActivity[i] : 0));
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

    // Hunger: decay per second when not eating; eat only when resting and near food (must land to eat)
    const canEat = restTimeLeft > 0;
    let hunger = fly.hunger;
    let isEating = false;
    if (canEat) {
      for (const s of worldSources) {
        if (s.type !== 'food') continue;
        const dist = Math.hypot(s.x - fly.x, s.y - fly.y);
        if (dist < EAT_RADIUS) {
          isEating = true;
          hunger = Math.min(100, hunger + EAT_RATE * dt);
          break;
        }
      }
    }
    if (!isEating) hunger = Math.max(0, hunger - HUNGER_DECAY * dt);

    // When not hungry (hunger > 90): stationary. When hungry: move and steer toward food.
    const hungry = hunger <= 90;
    const responsiveness = hungry ? (90 - hunger) / 90 : 0;

    let headingBias = turnFromMotor * dt + 0.1 * Math.sin(t * 0.7) * dt;
    if (hungry && worldSources.length > 0) {
      let nearestDist = Infinity;
      let nearestDx = 0;
      let nearestDy = 0;
      let nearestWeight = 1;
      for (const s of worldSources) {
        if (!isAttractorType(s.type)) continue;
        const dx = s.x - fly.x;
        const dy = s.y - fly.y;
        const dist = Math.hypot(dx, dy);
        const weight = s.type === 'food' ? 1 : 0.6;
        if (dist < s.radius && dist < nearestDist && dist > 0.5) {
          nearestDist = dist;
          nearestDx = dx;
          nearestDy = dy;
          nearestWeight = weight;
        }
      }
      if (nearestDist < Infinity) {
        const turn = angleToward(fly.heading, nearestDx, nearestDy);
        headingBias += turn * 0.8 * responsiveness * nearestWeight * dt;
      }
    }

    // Tired/rest: fly can only fly 5s at a time, then must rest. Lower hunger = longer rest.
    let effectiveMotor = hungry ? motor * responsiveness : 0;
    if (restTimeLeft > 0) {
      restTimeLeft -= dt;
      effectiveMotor = 0;
      if (restTimeLeft <= 0) flyTimeLeft = FLY_TIME_MAX;
    } else if (Math.abs(effectiveMotor) > 0.02) {
      flyTimeLeft -= dt * Math.abs(effectiveMotor);
      if (flyTimeLeft <= 0) {
        restTimeLeft = hunger > 50 ? 2 : 4; // hungrier = longer rest
      }
    } else {
      flyTimeLeft = Math.min(FLY_TIME_MAX, flyTimeLeft + dt * 0.5); // recover a bit when idle
    }

    const dx = Math.cos(fly.heading) * effectiveMotor * dt * 10;
    const dy = Math.sin(fly.heading) * effectiveMotor * dt * 10;
    let nx = fly.x + (Number.isFinite(dx) ? dx : 0);
    let ny = fly.y + (Number.isFinite(dy) ? dy : 0);
    nx = Math.max(-ARENA, Math.min(ARENA, nx));
    ny = Math.max(-ARENA, Math.min(ARENA, ny));

    const zDrift = Math.abs(effectiveMotor) > 0.02 ? 0.4 * dt : restTimeLeft > 0 ? -0.5 * dt : 0;
    const zOsc = 0.08 * Math.sin(t * 20) * dt;
    let nz = fly.z + (Number.isFinite(zDrift) ? zDrift : 0) + (Number.isFinite(zOsc) ? zOsc : 0);
    nz = Math.max(GROUND_Z, Math.min(FLIGHT_Z, nz));

    let nHeading = fly.heading + (Number.isFinite(headingBias) ? headingBias : 0);
    while (nHeading > Math.PI) nHeading -= 2 * Math.PI;
    while (nHeading < -Math.PI) nHeading += 2 * Math.PI;
    nHeading = Number.isFinite(nHeading) ? nHeading : fly.heading;
    fly = {
      x: Number.isFinite(nx) ? nx : fly.x,
      y: Number.isFinite(ny) ? ny : fly.y,
      z: Number.isFinite(nz) ? nz : fly.z,
      heading: Number.isFinite(nHeading) ? nHeading : fly.heading,
      t: Number.isFinite(t) ? t : fly.t,
      hunger: Number.isFinite(hunger) ? hunger : fly.hunger,
    };

    const actObj: Record<string, number> = {};
    neuronIds.forEach((id, i) => {
      const v = activity[i];
      if (v > 0.01 && Number.isFinite(v)) actObj[id] = Math.min(1, v);
    });

    return { t, fly, activity: Object.keys(actObj).length ? actObj : undefined };
  }

  function inject(neurons: string[], strength = 0.8) {
    if (neurons.length > 0) pendingStimuli.push({ neurons, strength });
  }

  function getState(): SimState {
    const actObj: Record<string, number> = {};
    neuronIds.forEach((id, i) => {
      const v = activity[i];
      if (v > 0.01 && Number.isFinite(v)) actObj[id] = Math.min(1, v);
    });
    return { t: fly.t, fly, activity: Object.keys(actObj).length ? actObj : undefined };
  }

  return { step, inject, getState, neuronIds };
}
