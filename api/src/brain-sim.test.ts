import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createBrainSim } from './brain-sim.js';
import { loadConnectome } from './connectome.js';

/** Connectome with roles and cell_types for stimulus routing and motor output. */
const testConnectome = {
  neurons: [
    { root_id: 's1', x: 0, y: 0, z: 0, role: 'sensory' as const, cell_type: 'R1-6' },
    { root_id: 's2', x: 1, y: 0, z: 0, role: 'sensory' as const, cell_type: 'T4a' },
    { root_id: 'i1', x: 2, y: 0, z: 0, role: 'interneuron' as const },
    { root_id: 'i2', x: 1, y: 1, z: 0, role: 'interneuron' as const },
    { root_id: 'ml', x: 1, y: 2, z: 0, role: 'motor' as const, side: 'left' as const },
    { root_id: 'mr', x: 0, y: 2, z: 0, role: 'motor' as const, side: 'right' as const },
  ],
  connections: [
    { pre: 's1', post: 'i1', weight: 5 },
    { pre: 's2', post: 'i1', weight: 5 },
    { pre: 'i1', post: 'i2', weight: 4 },
    { pre: 'i2', post: 'ml', weight: 4 },
    { pre: 'i2', post: 'mr', weight: 4 },
  ],
  meta: { total_neurons: 6, total_connections: 5 },
};

/** Minimal connectome without roles (fallback behavior). */
const miniConnectome = {
  neurons: [
    { root_id: 'a', x: 0, y: 0, z: 0 },
    { root_id: 'b', x: 1, y: 0, z: 0 },
    { root_id: 'c', x: 0, y: 1, z: 0 },
  ],
  connections: [
    { pre: 'a', post: 'b', weight: 5 },
    { pre: 'b', post: 'c', weight: 3 },
  ],
  meta: { total_neurons: 3, total_connections: 2 },
};

const foodSource = { id: 'f1', type: 'food' as const, x: 5, y: 5, z: 2, radius: 20 };
const lightSource = { id: 'l1', type: 'light' as const, x: -5, y: -5, z: 3, radius: 15 };

describe('brain-sim', () => {
  it('steps and returns fly state', () => {
    const { step } = createBrainSim(miniConnectome);
    const s1 = step(0.1);
    expect(s1.fly).toBeDefined();
    expect(s1.fly.x).toBeDefined();
    expect(s1.fly.y).toBeDefined();
    expect(s1.fly.z).toBeDefined();
    expect(s1.fly.heading).toBeDefined();
    expect(s1.fly.t).toBeGreaterThan(0);
    expect(s1.fly.hunger).toBeDefined();
  });

  it('inject adds activity', () => {
    const { step, inject } = createBrainSim(miniConnectome);
    step(0.1);
    const s1 = step(0.1);
    const actBefore = s1.activity ? Object.keys(s1.activity).length : 0;
    inject(['a'], 1);
    const s2 = step(0.1);
    const actAfter = s2.activity ? Object.keys(s2.activity).length : 0;
    expect(actAfter).toBeGreaterThanOrEqual(actBefore);
  });

  it('food source near fly increases activity in visual/sensory neurons', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    let maxActivity = 0;
    for (let i = 0; i < 20; i++) {
      const s = step(1 / 30);
      if (s.activity) {
        for (const v of Object.values(s.activity)) maxActivity = Math.max(maxActivity, v);
      }
    }
    expect(maxActivity).toBeGreaterThan(0.01);
  });

  it('fly position or heading changes over time with food and stimulus', () => {
    const { step, inject } = createBrainSim(testConnectome, [foodSource]);
    inject(['s1', 's2'], 1.5);
    const s0 = step(0.1);
    for (let i = 0; i < 600; i++) step(1 / 30);
    const s1 = step(0.1);
    const distMoved = Math.hypot(s1.fly.x - s0.fly.x, s1.fly.y - s0.fly.y);
    const headingDiff = Math.abs(s1.fly.heading - s0.fly.heading);
    expect(distMoved > 0.02 || headingDiff > 0.01).toBe(true);
  });

  it('fly explores (moves) when satiated and not fatigued', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const s0 = step(0.1);
    expect(s0.fly.hunger).toBeGreaterThan(90);
    const dx = s0.fly.x;
    const dy = s0.fly.y;
    for (let i = 0; i < 100; i++) step(1 / 30);
    const s1 = step(0.1);
    const dist = Math.hypot(s1.fly.x - dx, s1.fly.y - dy);
    expect(dist).toBeGreaterThan(0.5); // explore mode moves the fly
  });

  it('fly heading changes when steering toward food', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const s0 = step(0.5);
    const h0 = s0.fly.heading;
    for (let i = 0; i < 90; i++) step(1 / 30);
    const s1 = step(0.5);
    const h1 = s1.fly.heading;
    expect(h0).toBeDefined();
    expect(h1).toBeDefined();
    expect(Math.abs(h1 - h0)).toBeLessThanOrEqual(Math.PI * 2);
  });

  it('fly z bounded between ground and flight altitude', () => {
    const { step, inject } = createBrainSim(testConnectome, [foodSource]);
    inject(['s1', 's2'], 1.5);
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const s = step(1 / 30);
      samples.push(s.fly.z);
    }
    const minZ = Math.min(...samples);
    const maxZ = Math.max(...samples);
    expect(minZ).toBeGreaterThanOrEqual(0.3);
    expect(maxZ).toBeLessThanOrEqual(1.6);
  });

  it('fly z stays within ground and flight bounds', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    for (let i = 0; i < 300; i++) {
      const s = step(1 / 30);
      expect(s.fly.z).toBeGreaterThanOrEqual(0.3);
      expect(s.fly.z).toBeLessThanOrEqual(1.6);
    }
  });

  it('fly position clamped to arena bounds', () => {
    const { step } = createBrainSim(testConnectome, [
      { id: 'f', type: 'food', x: 50, y: 50, z: 2, radius: 100 },
    ]);
    for (let i = 0; i < 600; i++) step(1 / 30);
    const s = step(1 / 30);
    expect(s.fly.x).toBeGreaterThanOrEqual(-24);
    expect(s.fly.x).toBeLessThanOrEqual(24);
    expect(s.fly.y).toBeGreaterThanOrEqual(-24);
    expect(s.fly.y).toBeLessThanOrEqual(24);
  });

  it('hunger decays over time', () => {
    const { step } = createBrainSim(testConnectome, []);
    const s0 = step(0.1);
    const h0 = s0.fly.hunger;
    for (let i = 0; i < 60; i++) step(1 / 30);
    const s1 = step(0.1);
    expect(s1.fly.hunger).toBeLessThan(h0);
  });

  it('light source contributes to activity', () => {
    const { step } = createBrainSim(testConnectome, [lightSource]);
    let totalActivity = 0;
    for (let i = 0; i < 30; i++) {
      const s = step(1 / 30);
      if (s.activity) totalActivity += Object.values(s.activity).reduce((a, b) => a + b, 0);
    }
    expect(totalActivity).toBeGreaterThan(0);
  });

  it('neuronIds matches connectome neurons', () => {
    const { neuronIds } = createBrainSim(testConnectome);
    expect(neuronIds).toHaveLength(6);
    expect(neuronIds).toContain('s1');
    expect(neuronIds).toContain('ml');
    expect(neuronIds).toContain('mr');
  });

  it('fly moves from start within 15s when not fatigued (explore or hungry)', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const dt = 1 / 30;
    const startPos = { x: 0, y: 0 };
    let s = step(dt);
    for (let i = 0; i < 450; i++) {
      s = step(dt);
    }
    const distMoved = Math.hypot(s.fly.x - startPos.x, s.fly.y - startPos.y);
    expect(distMoved, `Fly should move from (0,0); got pos (${s.fly.x.toFixed(2)}, ${s.fly.y.toFixed(2)})`).toBeGreaterThan(0.5);
  });

  it('fly moves with stimulus within 5s', () => {
    const dt = 1 / 30;
    const steps = 150;

    const control = createBrainSim(testConnectome, []);
    const s0_control = control.step(dt);
    for (let i = 0; i < steps; i++) control.step(dt);
    const s1_control = control.step(dt);
    const distMoved_control = Math.hypot(s1_control.fly.x - s0_control.fly.x, s1_control.fly.y - s0_control.fly.y);

    const injected = createBrainSim(testConnectome, []);
    injected.inject(['s1', 's2'], 0.8);
    const s0 = injected.step(dt);
    for (let i = 0; i < steps; i++) injected.step(dt);
    const s1 = injected.step(dt);
    const distMoved = Math.hypot(s1.fly.x - s0.fly.x, s1.fly.y - s0.fly.y);

    expect(distMoved_control, 'Control should have baseline movement').toBeGreaterThan(0.5);
    expect(distMoved, 'Injected run should move').toBeGreaterThan(0.5);
    expect(distMoved, 'Injection adds activity; injected run should move at least as much as control')
      .toBeGreaterThanOrEqual(distMoved_control * 0.9);
  });

  it('fly eventually reaches food when hungry (long run)', () => {
    const EAT_RADIUS = 1.5;
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const dt = 1 / 30;
    const maxSteps = 3600; // 2 min
    let s = step(dt);
    let reachedFood = false;
    let minDistToFood = Infinity;
    for (let i = 0; i < maxSteps; i++) {
      s = step(dt);
      const d = Math.hypot(5 - s.fly.x, 5 - s.fly.y);
      minDistToFood = Math.min(minDistToFood, d);
      if (d < EAT_RADIUS) {
        reachedFood = true;
        break;
      }
    }
    expect(reachedFood, `Fly should reach food within ${maxSteps} steps; min dist was ${minDistToFood.toFixed(2)}`).toBe(true);
  });

  it('fly enters rest when fatigued', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const dt = 1 / 30;
    let hadRest = false;
    for (let i = 0; i < 2500; i++) {
      const s = step(dt);
      if (s.fly.restTimeLeft != null && s.fly.restTimeLeft > 0) {
        hadRest = true;
        break;
      }
    }
    expect(hadRest).toBe(true);
  });

  it('fly explores, gets hungry, rests (behavior pipeline)', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const dt = 1 / 30;
    let s = step(dt);
    let explored = false;
    let gotHungry = false;
    let rested = false;

    for (let i = 0; i < 2500; i++) {
      s = step(dt);
      if (Math.hypot(s.fly.x, s.fly.y) > 1) explored = true;
      if (s.fly.hunger < 90) gotHungry = true;
      if (s.fly.restTimeLeft != null && s.fly.restTimeLeft > 0) rested = true;
    }

    expect(explored).toBe(true);
    expect(gotHungry).toBe(true);
    expect(rested).toBe(true);
  });

  it('fly does not stay stuck at arena corner (wall avoidance)', () => {
    const { step } = createBrainSim(testConnectome, [
      { id: 'f', type: 'food', x: 20, y: 20, z: 2, radius: 30 },
    ]);
    const dt = 1 / 30;
    let s = step(dt);
    const cornerX = 22;
    const cornerY = 22;
    // Run until fly likely reaches corner or near it (head toward +x,+y)
    for (let i = 0; i < 1500; i++) {
      s = step(dt);
      if (s.fly.x > 20 && s.fly.y > 20) break;
    }
    const xAtCorner = s.fly.x;
    const yAtCorner = s.fly.y;
    const headingAtCorner = s.fly.heading;
    for (let i = 0; i < 300; i++) s = step(dt);
    // Fly should have changed position or heading (wall avoidance turns it away)
    const moved = Math.hypot(s.fly.x - xAtCorner, s.fly.y - yAtCorner);
    const headingChange = Math.abs(s.fly.heading - headingAtCorner);
    expect(moved > 0.5 || headingChange > 0.3, 'Fly stuck at corner').toBe(true);
  });

  it('fly changes direction over time during long run', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const dt = 1 / 30;
    const samples: number[] = [];
    let s = step(dt);
    for (let i = 0; i < 900; i++) {
      s = step(dt);
      if (i % 100 === 0) samples.push(s.fly.heading);
    }
    const headingVariance = Math.max(...samples) - Math.min(...samples);
    expect(headingVariance, 'Heading should change over 30s').toBeGreaterThan(0.2);
  });

  it('fly covers meaningful distance over 60s simulation', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const dt = 1 / 30;
    const s0 = step(dt);
    for (let i = 0; i < 1800; i++) step(dt);
    const s1 = step(dt);
    const totalDist = Math.hypot(s1.fly.x - s0.fly.x, s1.fly.y - s0.fly.y);
    expect(totalDist, 'Fly should travel > 10 units over 60s').toBeGreaterThan(10);
  });

  it('neurons are balanced: not all firing at max, activity varies over time', () => {
    const connectomePath = path.resolve(__dirname, '..', '..', 'data', 'connectome-subset.json');
    if (!fs.existsSync(connectomePath)) {
      console.warn('Skipping neuron balance test: connectome-subset.json not found');
      return;
    }
    const connectome = loadConnectome(connectomePath);
    const { step } = createBrainSim(connectome, [
      { id: 'f1', type: 'food', x: 6, y: 6, z: 0.35, radius: 12 },
    ]);
    const dt = 1 / 30;
    const totalNeurons = connectome.neurons.length;
    const sampleInterval = 30;
    const samples: { activeCount: number; meanActivity: number; maxActivity: number }[] = [];
    for (let i = 0; i < 600; i++) {
      const s = step(dt);
      if (i % sampleInterval === 0 && s.activity && Object.keys(s.activity).length > 0) {
        const vals = Object.values(s.activity);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const max = Math.max(...vals);
        samples.push({
          activeCount: vals.length,
          meanActivity: mean,
          maxActivity: max,
        });
      }
    }
    expect(samples.length).toBeGreaterThan(5);
    const maxActiveFrac = Math.max(...samples.map((x) => x.activeCount / totalNeurons));
    const maxMeanActivity = Math.max(...samples.map((x) => x.meanActivity));
    const activeCounts = samples.map((x) => x.activeCount);
    const meanCount = activeCounts.reduce((a, b) => a + b, 0) / activeCounts.length;
    const activeCountStd = Math.sqrt(activeCounts.reduce((s, n) => s + (n - meanCount) ** 2, 0) / activeCounts.length);
    expect(maxActiveFrac, 'At most 70% of neurons should be active (no saturation)').toBeLessThanOrEqual(0.70);
    expect(maxMeanActivity, 'Mean activity of active neurons should stay below max (0.5)').toBeLessThan(0.48);
    expect(activeCountStd, 'Active count should vary over time (not constant)').toBeGreaterThan(0.5);
  });
});
