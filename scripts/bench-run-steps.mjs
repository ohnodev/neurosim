#!/usr/bin/env node
/**
 * Benchmark run_steps: one round-trip with N steps (default 1000).
 * Requires brain-service running on NEUROSIM_BRAIN_SOCKET (default /tmp/neurosim-brain.sock).
 * Usage: node scripts/bench-run-steps.mjs [STEPS=1000]
 */
import net from 'node:net';

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const STEPS = Number(process.env.BENCH_STEPS || process.argv[2] || 1000);
const DT = Number(process.env.BENCH_DT || 0.0001);
const RUNS = Number(process.env.BENCH_RUNS || 5);

function sendRequest(sock, payload) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify(payload) + '\n';
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      sock.off('data', onData);
      try {
        const out = JSON.parse(line);
        if (out?.error) reject(new Error(out.error));
        else resolve(out);
      } catch (err) {
        reject(err);
      }
    };
    sock.on('data', onData);
    sock.write(msg, (err) => {
      if (err) {
        sock.off('data', onData);
        reject(err);
      }
    });
  });
}

async function run() {
  const sock = net.createConnection(SOCKET_PATH);
  sock.setTimeout(3000, () => {
    sock.destroy(new Error('Connection timeout (is brain-service running?)'));
  });
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  sock.setTimeout(0);
  await sendRequest(sock, { method: 'ping' });

  const createRes = await sendRequest(sock, { method: 'create', params: {} });
  const simId = createRes.sim_id;

  const clientTimes = [];
  let stepsLoopMsSum = 0;
  let stepsLoopMsCount = 0;

  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    const res = await sendRequest(sock, {
      method: 'run_steps',
      params: {
        sim_id: simId,
        num_steps: STEPS,
        dt: DT,
        return_final_state: true,
        stim_rates_by_id: {},
        fly: {
          x: 0,
          y: 0,
          z: 0.35,
          heading: 0,
          t: 0,
          hunger: 50,
          health: 100,
          rest_time_left: 0,
          dead: false,
        },
        sources: [],
      },
    });
    const clientMs = performance.now() - t0;
    clientTimes.push(clientMs);
    if (typeof res.steps_loop_ms === 'number') {
      stepsLoopMsSum += res.steps_loop_ms;
      stepsLoopMsCount += 1;
    }
  }

  sock.end();

  const avgClientMs = clientTimes.reduce((a, b) => a + b, 0) / clientTimes.length;
  const avgStepsLoopMs = stepsLoopMsCount ? stepsLoopMsSum / stepsLoopMsCount : null;
  const msPerTickClient = avgClientMs / STEPS;
  const msPerTickServer = avgStepsLoopMs != null ? avgStepsLoopMs / STEPS : null;

  console.log('');
  console.log('run_steps benchmark');
  console.log('  steps per call:', STEPS);
  console.log('  dt (sim):', DT, 's (0.1 ms per tick)');
  console.log('  runs:', RUNS);
  console.log('');
  console.log('  client wall (avg):', avgClientMs.toFixed(2), 'ms');
  console.log('  client ms/tick:    ', msPerTickClient.toFixed(4), 'ms');
  if (avgStepsLoopMs != null) {
    console.log('  server steps_loop: ', avgStepsLoopMs.toFixed(2), 'ms');
    console.log('  server ms/tick:   ', (avgStepsLoopMs / STEPS).toFixed(4), 'ms');
  }
  console.log('');
  if (avgStepsLoopMs != null) {
    const targetMs = 1;
    const ok = avgStepsLoopMs <= targetMs * 10; // allow 10ms for 1000 ticks as "easy"
    console.log('  Target: 1000 ticks in under ~10 ms (server loop). Actual:', avgStepsLoopMs.toFixed(1), 'ms →', ok ? 'OK' : 'SLOW');
  }
  console.log('');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
