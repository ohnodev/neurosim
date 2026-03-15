/**
 * Integration tests for the brain simulation: validates that simulations run
 * correctly end-to-end (neural propagation, fly physics, activity output).
 * Works with both Rust and TypeScript backends.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import WebSocket from 'ws';
import { app, httpServer, startSim, stopSim, resetDeployStateForTesting } from './index.js';
import { createBrainSim } from './brain-sim.js';
import { loadConnectome } from './connectome.js';
import { addFly } from './services/flyStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectomePath = path.resolve(__dirname, '..', '..', 'data', 'connectome-subset.json');

describe('simulation integration', () => {
  describe('brain sim backend', () => {
    it('creates sim and reports backend (Rust or TS)', async () => {
      const connectome = loadConnectome(connectomePath);
      const sim = await createBrainSim(connectome, []);
      expect(sim.step).toBeDefined();
      expect(sim.getState).toBeDefined();
      expect(sim.neuronIds.length).toBe(connectome.neurons.length);
    });

    it('runs long simulation with real connectome: valid fly state and activity', async () => {
      const connectome = loadConnectome(connectomePath);
      const food = { id: 'f1', type: 'food' as const, x: 5, y: 5, z: 2, radius: 20 };
      const { step } = await createBrainSim(connectome, [food]);
      const dt = 1 / 30;
      let lastState = await step(dt);

      for (let i = 0; i < 600; i++) {
        lastState = await step(dt);
        expect(Number.isFinite(lastState.fly.x)).toBe(true);
        expect(Number.isFinite(lastState.fly.y)).toBe(true);
        expect(Number.isFinite(lastState.fly.z)).toBe(true);
        expect(Number.isFinite(lastState.fly.heading)).toBe(true);
        expect(Number.isFinite(lastState.fly.t)).toBe(true);
        expect(Number.isFinite(lastState.fly.hunger)).toBe(true);
        expect(Number.isFinite(lastState.fly.health ?? 100)).toBe(true);
      }

      const distMoved = Math.hypot(lastState.fly.x, lastState.fly.y);
      expect(distMoved, 'Fly should have moved from origin').toBeGreaterThan(0.5);
      expect(lastState.t, 'Simulation time should advance').toBeGreaterThan(10);
    });

  });

  describe('API simulation flow', () => {
    const TEST_ADDR = '0x0000000000000000000000000000000000000001';
    let port: number;

    beforeAll(async () => {
      addFly(TEST_ADDR, { method: 'pay', claimedAt: new Date().toISOString(), seed: 1 });
      await new Promise<void>((resolve) => {
        httpServer.listen(0, () => {
          port = (httpServer.address() as { port: number }).port;
          startSim();
          resolve();
        });
      });
    });

    afterAll(async () => {
      stopSim();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    });

    beforeEach(() => {
      resetDeployStateForTesting();
    });

    it('deploy + WebSocket delivers frames with valid simulation data', async () => {
      const res = await request(app)
        .post('/api/deploy')
        .send({ address: TEST_ADDR, slotIndex: 0 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const payloads: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS timeout')), 30000);
        let frameCount = 0;
        ws.on('message', (data) => {
          const p = JSON.parse(data.toString());
          payloads.push(p);
          const frames = (p as { frames?: unknown[] }).frames;
          if (Array.isArray(frames) && frames.length > 0) {
            frameCount += frames.length;
            if (frameCount >= 3) {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
        ws.on('error', reject);
      });
      ws.close();

      expect(payloads.length).toBeGreaterThan(0);
      const last = payloads[payloads.length - 1] as { frames?: { t?: number; flies?: unknown[]; activities?: unknown[]; sources?: unknown[] }[] };
      expect(Array.isArray(last.frames)).toBe(true);
      const frame = last.frames![0];
      expect(frame).toBeDefined();
      expect(Number.isFinite(frame.t)).toBe(true);
      expect(Array.isArray(frame.flies)).toBe(true);
      const fly = frame.flies![0] as { x?: number; y?: number; z?: number; hunger?: number; health?: number };
      expect(typeof fly.x).toBe('number');
      expect(typeof fly.y).toBe('number');
      expect(typeof fly.z).toBe('number');
      expect(fly.hunger).toBeGreaterThanOrEqual(0);
      expect(fly.health).toBeGreaterThanOrEqual(0);
    });
  });
});
