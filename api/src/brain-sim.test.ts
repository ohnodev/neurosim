import { describe, it, expect } from 'vitest';
import { createBrainSim } from './brain-sim.js';

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

describe('brain-sim', () => {
  it('steps and returns fly state', () => {
    const { step } = createBrainSim(miniConnectome);
    const s1 = step(0.1);
    expect(s1.fly).toBeDefined();
    expect(s1.fly.x).toBeDefined();
    expect(s1.fly.t).toBeGreaterThan(0);
  });

  it('inject adds activity', () => {
    const { step, inject } = createBrainSim(miniConnectome);
    const s1 = step(0.1);
    const actBefore = s1.activity ? Object.keys(s1.activity).length : 0;
    inject(['a'], 1);
    const s2 = step(0.1);
    const actAfter = s2.activity ? Object.keys(s2.activity).length : 0;
    expect(actAfter).toBeGreaterThanOrEqual(actBefore);
  });
});
