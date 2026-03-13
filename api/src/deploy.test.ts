import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { app, httpServer, startSim, stopSim, resetDeployStateForTesting } from './index.js';
import { addFly, getFlies } from './services/flyStore.js';

const TEST_ADDR = '0x0000000000000000000000000000000000000001';

describe('deploy API (no server)', () => {
  it('POST /api/deploy returns 400 when no fly in slot', async () => {
    const noFlyAddr = '0x0000000000000000000000000000000000000000';
    const res = await request(app)
      .post('/api/deploy')
      .send({ address: noFlyAddr, slotIndex: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No fly');
  });

  it('POST /api/deploy returns 400 for invalid address', async () => {
    const res = await request(app).post('/api/deploy').send({ address: 'bad', slotIndex: 0 });
    expect(res.status).toBe(400);
  });

  it('POST /api/deploy returns 400 for invalid slotIndex', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({ address: TEST_ADDR, slotIndex: 5 });
    expect(res.status).toBe(400);
  });

  it('POST /api/deploy/send-to-graveyard frees slot for repurchase', async () => {
    const addr = '0x00000000000000000000000000000000000000aa';
    addFly(addr, { method: 'pay', claimedAt: new Date().toISOString(), seed: 11 });
    addFly(addr, { method: 'pay', claimedAt: new Date().toISOString(), seed: 12 });
    addFly(addr, { method: 'pay', claimedAt: new Date().toISOString(), seed: 13 });
    expect(getFlies(addr).filter(Boolean).length).toBe(3);

    const res = await request(app)
      .post('/api/deploy/send-to-graveyard')
      .send({ address: addr, slotIndex: 1 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(getFlies(addr).filter(Boolean).length).toBe(2);

    const added = addFly(addr, { method: 'pay', claimedAt: new Date().toISOString(), seed: 14 });
    expect(added).not.toBeNull();
    expect(getFlies(addr).filter(Boolean).length).toBe(3);
  });
});

describe('deploy flow: buy fly + deploy + sim updates', () => {
  let port: number;

  beforeAll(async () => {
    addFly(TEST_ADDR, {
      method: 'pay',
      claimedAt: new Date().toISOString(),
      seed: 1,
    });
    addFly(TEST_ADDR, {
      method: 'pay',
      claimedAt: new Date().toISOString(),
      seed: 2,
    });
    expect(getFlies(TEST_ADDR).length).toBeGreaterThanOrEqual(2);

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

  it('deploys a fly and sim receives it via WebSocket', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({ address: TEST_ADDR, slotIndex: 0 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.simIndex).toBe('number');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const payloads: { flies?: unknown[]; t?: number }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS timeout')), 10000);
      ws.on('message', (data) => {
        const p = JSON.parse(data.toString());
        payloads.push(p);
        const flies = p.frames?.[0]?.flies ?? p.flies;
        if (Array.isArray(flies) && flies.length >= 1) {
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    ws.close();

    expect(payloads.length).toBeGreaterThan(0);
    const last = payloads[payloads.length - 1];
    const flies = (last as { frames?: { flies?: unknown[] }[]; flies?: unknown[] }).frames?.[0]?.flies ?? (last as { flies?: unknown[] }).flies;
    expect(Array.isArray(flies)).toBe(true);
    expect(flies!.length).toBeGreaterThanOrEqual(1);
    const fly = flies![0] as { x?: number; y?: number; hunger?: number; health?: number };
    expect(typeof fly.x).toBe('number');
    expect(typeof fly.y).toBe('number');
    expect(fly.hunger).toBeGreaterThanOrEqual(0);
    expect(fly.health).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/deploy/my-deployed returns deployed slots', async () => {
    await request(app).post('/api/deploy').send({ address: TEST_ADDR, slotIndex: 0 });
    const res = await request(app).get(`/api/deploy/my-deployed?address=${TEST_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.deployed).toBeDefined();
    expect(res.body.deployed[0]).toBe(0);
  });

  it('deploys 4–5 flies and sim handles all', async () => {
    const otherAddr = '0x0000000000000000000000000000000000000002';
    addFly(otherAddr, { method: 'pay', claimedAt: new Date().toISOString(), seed: 1 });
    addFly(otherAddr, { method: 'pay', claimedAt: new Date().toISOString(), seed: 2 });
    addFly(otherAddr, { method: 'pay', claimedAt: new Date().toISOString(), seed: 3 });

    await request(app).post('/api/deploy').send({ address: TEST_ADDR, slotIndex: 0 });
    await request(app).post('/api/deploy').send({ address: TEST_ADDR, slotIndex: 1 });
    await request(app).post('/api/deploy').send({ address: otherAddr, slotIndex: 0 });
    await request(app).post('/api/deploy').send({ address: otherAddr, slotIndex: 1 });
    await request(app).post('/api/deploy').send({ address: otherAddr, slotIndex: 2 });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const payloads: { flies?: unknown[] }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS timeout')), 10000);
      ws.on('message', (data) => {
        const p = JSON.parse(data.toString());
        payloads.push(p);
        const flies = p.frames?.[0]?.flies ?? p.flies;
        if (Array.isArray(flies) && flies.length >= 5) {
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.on('error', reject);
    });
    ws.close();

    const last = payloads[payloads.length - 1];
    const fliesData = (last as { frames?: { flies?: unknown[] }[]; flies?: unknown[] }).frames?.[0]?.flies ?? (last as { flies?: unknown[] }).flies;
    expect(fliesData!.length).toBeGreaterThanOrEqual(5);
    const flies = fliesData! as Array<{ x: number; y: number }>;
    const positions = new Set(flies.map((f) => `${f.x.toFixed(2)},${f.y.toFixed(2)}`));
    expect(positions.size).toBe(flies.length);
  });
});
