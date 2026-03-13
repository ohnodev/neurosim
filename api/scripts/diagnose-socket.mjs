#!/usr/bin/env node
/**
 * Diagnose brain socket: create sim + 5 steps, log timing.
 * Run: node scripts/diagnose-socket.mjs (brain-service must be running)
 */
import { createConnection } from 'net';
import { createInterface } from 'readline';

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';

function request(payload) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET_PATH, () => {
      sock.write(JSON.stringify(payload) + '\n', (err) => err && reject(err));
    });
    const rl = createInterface({ input: sock, crlfDelay: Infinity });
    rl.once('line', (line) => {
      rl.close();
      sock.destroy();
      try {
        const out = JSON.parse(line);
        if (out.error) reject(new Error(out.error));
        else resolve(out);
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', reject);
  });
}

async function main() {
  console.log('[diagnose] connecting to', SOCKET_PATH);
  const t0 = Date.now();
  const createRes = await request({ method: 'create', params: {} });
  console.log('[diagnose] create sim', createRes.sim_id, 'in', Date.now() - t0, 'ms');
  const simId = createRes.sim_id;
  const fly = { x: 2, y: 1, z: 0.35, heading: 0, t: 0, hunger: 80, health: 100, rest_time_left: 0 };
  const params = (i) => ({
    method: 'step',
    params: {
      sim_id: simId,
      dt: 1 / 30,
      fly: { ...fly, t: (i * 1) / 30 },
      sources: [],
      pending: [],
    },
  });
  for (let i = 0; i < 5; i++) {
    const t1 = Date.now();
    await request(params(i));
    console.log('[diagnose] step', i + 1, 'took', Date.now() - t1, 'ms');
  }
  console.log('[diagnose] done, 5 steps total');
}

main().catch((e) => {
  console.error('[diagnose] error:', e.message);
  process.exit(1);
});
