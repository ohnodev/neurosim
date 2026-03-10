import type { Connectome, Connection } from './connectome.js';
import { buildAdjacency } from './connectome.js';

export interface FlyState {
  x: number;
  y: number;
  z: number;
  heading: number;
  t: number;
}

export interface SimState {
  t: number;
  fly: FlyState;
  activity?: Record<string, number>;
}

export function createBrainSim(connectome: Connectome) {
  const adj = buildAdjacency(connectome.connections);
  const neuronIds = connectome.neurons.map((n) => n.root_id);
  const idToIdx = new Map<string, number>();
  neuronIds.forEach((id, i) => idToIdx.set(id, i));

  let activity = new Float32Array(neuronIds.length);
  let fly: FlyState = { x: 0, y: 0, z: 2, heading: 0, t: 0 };
  const pendingStimuli: { neurons: string[]; strength: number }[] = [];

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

    fly = {
      x: fly.x + Math.cos(fly.heading) * motor * dt * 10,
      y: fly.y + Math.sin(fly.heading) * motor * dt * 10,
      z: fly.z + 0.1 * Math.sin(t) * dt,
      heading: fly.heading + 0.2 * Math.sin(t * 0.7) * dt,
      t,
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
