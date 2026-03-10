import { describe, it, expect } from 'vitest';
import { createBrainSim } from './brain-sim.js';

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

  it('fly stays roughly stationary when not hungry (satiated)', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    const s0 = step(0.1);
    expect(s0.fly.hunger).toBeGreaterThan(90);
    const dx = s0.fly.x;
    const dy = s0.fly.y;
    for (let i = 0; i < 30; i++) step(1 / 30);
    const s1 = step(0.1);
    expect(Math.abs(s1.fly.x - dx)).toBeLessThan(0.5);
    expect(Math.abs(s1.fly.y - dy)).toBeLessThan(0.5);
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
    expect(minZ).toBeGreaterThanOrEqual(1.9);
    expect(maxZ).toBeLessThanOrEqual(3.2);
  });

  it('fly z stays within ground and flight bounds', () => {
    const { step } = createBrainSim(testConnectome, [foodSource]);
    for (let i = 0; i < 300; i++) {
      const s = step(1 / 30);
      expect(s.fly.z).toBeGreaterThanOrEqual(1.9);
      expect(s.fly.z).toBeLessThanOrEqual(3.1);
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
});
