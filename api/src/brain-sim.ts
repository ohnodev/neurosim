import type { Connectome } from './connectome.js';
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
  const neuronIds = connectome.neurons.map((n) => n.root_id);
  const idToIdx = new Map<string, number>();
  neuronIds.forEach((id, i) => idToIdx.set(id, i));

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

    // Inject noise into a few "sensory" neurons
    const sensoryCount = Math.min(5, Math.floor(neuronIds.length / 100));
    for (let k = 0; k < sensoryCount; k++) {
      const idx = (Math.floor(t * INPUT_RATE) + k * 17) % neuronIds.length;
      nextActivity[idx] += 0.3 * (0.5 + 0.5 * Math.sin(t * 3 + k));
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

    // Map activity to motor: sum of output neurons -> velocity
    let motor = 0;
    for (let i = 0; i < activity.length; i++) {
      motor += activity[i] * 0.001;
    }
    motor = Math.tanh(motor) * 0.5;

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

    let headingBias = 0.2 * Math.sin(t * 0.7) * dt;
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

    fly = {
      x: nx,
      y: ny,
      z: fly.z + 0.1 * Math.sin(t) * dt,
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
