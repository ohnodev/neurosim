import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import claimsRouter from './claims.js';

const app = express();
app.use(express.json());
app.use('/api/claim', claimsRouter);

describe('claims API', () => {
  it('GET /api/claim/config returns config with addresses', async () => {
    const res = await request(app).get('/api/claim/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('neuroTokenAddress');
    expect(res.body).toHaveProperty('claimReceiverAddress');
    expect(res.body).toHaveProperty('flyEthReceiver');
    expect(res.body).toHaveProperty('flyEthAmountWei');
    expect(typeof res.body.flyEthAmountWei).toBe('string');
    expect(/^0x[a-fA-F0-9]{40}$/.test(res.body.flyEthReceiver)).toBe(true);
  });

  it('GET /api/claim/my-flies returns flies array for valid address', async () => {
    const addr = '0x1234567890123456789012345678901234567890';
    const res = await request(app).get(`/api/claim/my-flies?address=${addr}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('flies');
    expect(Array.isArray(res.body.flies)).toBe(true);
    expect(res.body.flies.length).toBeLessThanOrEqual(3);
  });

  it('GET /api/claim/my-flies returns 400 for invalid address', async () => {
    const res = await request(app).get('/api/claim/my-flies?address=invalid');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('GET /api/claim/my-flies returns 400 for missing address', async () => {
    const res = await request(app).get('/api/claim/my-flies');
    expect(res.status).toBe(400);
  });
});
