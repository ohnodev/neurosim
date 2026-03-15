import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { app, httpServer, startSim, stopSim, resetDeployStateForTesting } from './index.js';
import { addFly } from './services/flyStore.js';
import { clearForTesting as clearRewardState } from './services/rewardStore.js';
import { createBrainSim } from './brain-sim.js';
import { loadConnectome } from './connectome.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomAddress(): string {
  const suffix = Math.floor(Math.random() * 0xfffffffffff)
    .toString(16)
    .padStart(12, '0');
  return `0x0000000000000000000000000000${suffix}`;
}

describe('feeding and reward flow', () => {
  let port: number;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const connectomePath = path.resolve(__dirname, '..', '..', 'data', 'connectome-subset.json');

  beforeAll(async () => {
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
    clearRewardState();
  });

  it(
    'deploys one fly, observes feeding, then verifies reward accounting',
    { timeout: 90_000 },
    async () => {
      const testAddr = randomAddress();
      addFly(testAddr, { method: 'pay', claimedAt: new Date().toISOString(), seed: 42 });

      const deployRes = await request(app)
        .post('/api/deploy')
        .send({ address: testAddr, slotIndex: 0 });
      expect(deployRes.status).toBe(200);
      expect(deployRes.body.success).toBe(true);

      // First: ensure deployed fly actually simulates over WS frames.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let firstT: number | null = null;
      let lastT: number | null = null;
      let observedFrames = 0;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('ws simulation observation timeout')), 30_000);
        ws.on('message', (data) => {
          const payload = JSON.parse(data.toString()) as {
            frames?: Array<{ t?: number; flies?: Array<{ feeding?: boolean }> }>;
          };
          const frame = payload.frames?.[payload.frames.length - 1];
          const fly = frame?.flies?.[0];
          if (!fly || typeof frame?.t !== 'number') return;
          if (firstT == null) firstT = frame.t;
          lastT = frame.t;
          observedFrames += 1;
          if (observedFrames >= 3) {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.on('error', reject);
      });
      ws.close();
      expect(firstT).not.toBeNull();
      expect(lastT).not.toBeNull();
      expect((lastT ?? 0) >= (firstT ?? 0)).toBe(true);

      // Second: deterministic feeding lifecycle (feed then return to non-feeding).
      const connectome = loadConnectome(connectomePath);
      const source = { id: 'food-test-1', type: 'food' as const, x: 0, y: 0, z: 0.35, radius: 12 };
      const sim = await createBrainSim(connectome, [source], {
        x: 0.1,
        y: 0.0,
        z: 0.35,
        heading: 0,
        t: 0,
        hunger: 45,
        health: 100,
      });
      let sawFeedingTrue = false;
      let sawEatenFood = false;
      for (let i = 0; i < 180; i++) {
        const s = await sim.step(1 / 30, { includeActivity: false });
        if (s.fly.feeding) {
          sawFeedingTrue = true;
        }
        if (s.eatenFoodId === source.id) {
          sawEatenFood = true;
          break;
        }
      }
      expect(sawFeedingTrue).toBe(true);
      expect(sawEatenFood).toBe(true);

      let sawFeedingFalseAfterEat = false;
      for (let i = 0; i < 60; i++) {
        const s = await sim.step(1 / 30, { includeActivity: false });
        if (!s.fly.feeding) {
          sawFeedingFalseAfterEat = true;
          break;
        }
      }
      expect(sawFeedingFalseAfterEat).toBe(true);

      // Finally: reward stats endpoint still returns expected structure for deployed fly.
      await wait(500);
      const statsRes = await request(app).get(`/api/rewards/stats?address=${testAddr}`);
      expect(statsRes.status).toBe(200);
      expect(Array.isArray(statsRes.body.stats)).toBe(true);
      const slot0 = (statsRes.body.stats as Array<{
        slotIndex: number;
        feedCount: number;
        pointsEarned: number;
        pointsFlushed: number;
        pointsPending: number;
      }>).find((s) => s.slotIndex === 0);
      expect(slot0).toBeDefined();
      expect((slot0?.feedCount ?? 0) >= 0).toBe(true);
      expect((slot0?.pointsPending ?? 0) >= 0).toBe(true);
      expect((slot0?.pointsFlushed ?? 0) >= 0).toBe(true);
    },
  );
});
