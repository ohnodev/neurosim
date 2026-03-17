import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './index.js';
import * as socketClient from './brain-socket-client.js';

describe('python-brain flow', () => {
  it('socket ping/create/step works with API contract', async () => {
    await socketClient.ping();
    const { simId } = await socketClient.createSim();
    expect(simId).toBeGreaterThan(0);

    const out = await socketClient.stepSim({
      simId,
      dt: 0.001,
      includeActivity: true,
      fly: {
        x: 0,
        y: 0,
        z: 0.35,
        heading: 0,
        t: 0,
        hunger: 40,
        health: 100,
        restTimeLeft: 0,
        dead: false,
      },
      sources: [],
    });

    expect(out.fly).toBeDefined();
    expect(Number.isFinite(out.fly.x)).toBe(true);
    expect(Number.isFinite(out.fly.y)).toBe(true);
    expect(Number.isFinite(out.fly.z)).toBe(true);
    expect(typeof out.activitySparse).toBe('object');
  });

  it('baseline export endpoint works on python-brain', async () => {
    const res = await request(app)
      .post('/api/neurosim-baseline/export')
      .send({
        ticks: 20,
        dtSec: 0.001,
        olfactoryBaselineRateHz: 20,
        thermoHz: 0.5,
        hygroHz: 0.5,
        gustatoryHz: 0,
        mechanoHz: 0,
        batchSize: 10,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ticks).toBe(20);
  });
});
