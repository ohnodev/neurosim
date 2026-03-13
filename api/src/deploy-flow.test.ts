/**
 * Deploy flow test: POST /api/deploy + WebSocket must deliver frames with simulating flies.
 * Requires neurosim-brain to be running (socket at /tmp/neurosim-brain.sock).
 * Run: npm run test:deploy
 */
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { app, httpServer, startSim, stopSim, resetDeployStateForTesting } from './index.js';
import { addFly } from './services/flyStore.js';

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
  await new Promise<void>((r) => httpServer.close(() => r()));
});

beforeEach(() => {
  resetDeployStateForTesting();
});

it('deploy creates sim and WebSocket delivers frames with advancing fly state', async () => {
  const res = await request(app)
    .post('/api/deploy')
    .send({ address: TEST_ADDR, slotIndex: 0 });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(typeof res.body.simIndex).toBe('number');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const payloads: Array<{ frames?: { t?: number; flies?: { x?: number; y?: number; t?: number }[] }[] }> = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('WebSocket timeout: no frames with flies in 15s')),
      15000
    );
    let gotFramesWithFly = 0;
    ws.on('message', (data) => {
      const p = JSON.parse(data.toString()) as (typeof payloads)[0];
      payloads.push(p);
      const frames = p.frames;
      if (Array.isArray(frames) && frames.length > 0) {
        const lastFrame = frames[frames.length - 1];
        const flies = lastFrame?.flies;
        if (Array.isArray(flies) && flies.length >= 1) {
          gotFramesWithFly += frames.length;
          if (gotFramesWithFly >= 5) {
            clearTimeout(timeout);
            resolve();
          }
        }
      }
    });
    ws.on('error', reject);
  });
  ws.close();

  expect(payloads.length).toBeGreaterThan(0);
  const last = payloads[payloads.length - 1];
  expect(Array.isArray(last?.frames)).toBe(true);
  const frame0 = last!.frames![0];
  const frameN = last!.frames![last!.frames!.length - 1];
  const fly0 = frame0?.flies?.[0];
  const flyN = frameN?.flies?.[0];
  expect(fly0).toBeDefined();
  expect(flyN).toBeDefined();
  expect(Number.isFinite(fly0!.x)).toBe(true);
  expect(Number.isFinite(fly0!.y)).toBe(true);
  expect(Number.isFinite(flyN!.x)).toBe(true);
  expect(Number.isFinite(flyN!.y)).toBe(true);
  expect(Number.isFinite(frame0?.t)).toBe(true);
  expect(Number.isFinite(frameN?.t)).toBe(true);
  expect(frameN!.t!, 'sim time must advance').toBeGreaterThanOrEqual(frame0!.t!);
});
