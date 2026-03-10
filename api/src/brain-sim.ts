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
  const HUNGER_DECAY = 1 / 30; // 1 per second at 30Hz
  const EAT_RATE = 15 / 30;    // +15 per second when eating
  const FLY_TIME_MAX = 5;      // max seconds of continuous flight
  let fly: FlyState = { x: 0, y: 0, z: 2, heading: 0, t: 0, hunger: 100 };
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
        if (j != null) nextActivity[j] += activity[i] * TAU * Math.min(weight, 10);
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

    // Hunger: decay 1/sec; eat only when resting and near food (must land to eat)
    let hunger = Math.max(0, fly.hunger - HUNGER_DECAY);
    const canEat = restTimeLeft > 0;
    if (canEat) {
      for (const s of worldSources) {
        if (s.type !== 'food') continue;
        const dist = Math.hypot(s.x - fly.x, s.y - fly.y);
        if (dist < EAT_RADIUS) hunger = Math.min(100, hunger + EAT_RATE);
      }
    }

    // When not hungry (hunger > 90): stationary. When hungry: move and steer toward food.
    const hungry = hunger <= 90;
    const responsiveness = hungry ? (90 - hunger) / 90 : 0;

    let headingBias = turnFromMotor * dt + 0.1 * Math.sin(t * 0.7) * dt;
    if (hungry && worldSources.length > 0) {
      let nearestDist = Infinity;
      let nearestDx = 0;
      let nearestDy = 0;
      for (const s of worldSources) {
        if (s.type !== 'food') continue;
        const dx = s.x - fly.x;
        const dy = s.y - fly.y;
        const dist = Math.hypot(dx, dy);
        if (dist < s.radius && dist < nearestDist && dist > 0.5) {
          nearestDist = dist;
          nearestDx = dx;
          nearestDy = dy;
        }
      }
      if (nearestDist < Infinity) {
        const turn = angleToward(fly.heading, nearestDx, nearestDy);
        headingBias += turn * 0.8 * responsiveness * dt;
      }
    }

    // Tired/rest: fly can only fly 5s at a time, then must rest. Lower hunger = longer rest.
    let effectiveMotor = hungry ? motor * responsiveness : 0;
    if (restTimeLeft > 0) {
      restTimeLeft -= dt;
      effectiveMotor = 0;
      if (restTimeLeft <= 0) flyTimeLeft = FLY_TIME_MAX;
    } else if (effectiveMotor > 0.02) {
      flyTimeLeft -= dt;
      if (flyTimeLeft <= 0) {
        restTimeLeft = hunger > 50 ? 2 : 4; // hungrier = longer rest
      }
    } else {
      flyTimeLeft = Math.min(FLY_TIME_MAX, flyTimeLeft + dt * 0.5); // recover a bit when idle
    }

    let nx = fly.x + Math.cos(fly.heading) * effectiveMotor * dt * 10;
    let ny = fly.y + Math.sin(fly.heading) * effectiveMotor * dt * 10;
    nx = Math.max(-ARENA, Math.min(ARENA, nx));
    ny = Math.max(-ARENA, Math.min(ARENA, ny));

    const groundZ = 2;
    const flightZ = 3;
    const zDrift = effectiveMotor > 0.02 ? 0.3 * dt : restTimeLeft > 0 ? -0.4 * dt : 0;
    const zOsc = 0.08 * Math.sin(t * 20) * dt;
    let nz = fly.z + zDrift + zOsc;
    nz = Math.max(groundZ, Math.min(flightZ, nz));

    fly = {
      x: nx,
      y: ny,
      z: nz,
      heading: fly.heading + headingBias,
      t,
      hunger,
    };

    const actObj: Record<string, number> = {};
    neuronIds.forEach((id, i) => {
      if (activity[i] > 0.01) actObj[id] = activity[i];
    });

    return { t, fly, activity: Object.keys(actObj).length ? actObj : undefined };
  }

  function inject(neurons: string[], strength = 0.8) {
    if (neurons.length > 0) pendingStimuli.push({ neurons, strength });
  }

  return { step, inject, neuronIds };
}
