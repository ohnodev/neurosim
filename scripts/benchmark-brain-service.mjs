#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const RUNS = Number(process.env.BENCH_RUNS || 2);
const STEPS = Number(process.env.BENCH_STEPS || 220);
const DT = Number(process.env.BENCH_DT || 0.0001);
const OUT_DIR = path.resolve(process.cwd(), 'logs');
const OUT_CSV = path.join(OUT_DIR, 'brain-service-benchmark.csv');

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

function avg(xs) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
}

function median(xs) {
  if (xs.length === 0) return 0;
  const y = [...xs].sort((a, b) => a - b);
  const m = Math.floor(y.length / 2);
  return y.length % 2 ? y[m] : (y[m - 1] + y[m]) / 2;
}

async function run() {
  const sock = net.createConnection(SOCKET_PATH);
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  await sendRequest(sock, { method: 'ping' });

  const rows = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const createStart = performance.now();
    const createRes = await sendRequest(sock, { method: 'create', params: {} });
    const createMs = performance.now() - createStart;
    const simId = createRes.sim_id;
    const perStepClient = [];
    const perStepCompute = [];
    const perStepKernel = [];
    const perStepRecurrent = [];
    const perStepLif = [];
    const perStepReadout = [];

    for (let i = 0; i < STEPS; i += 1) {
      const fly = {
        x: 0,
        y: 0,
        z: 0.35,
        heading: 0,
        t: i * DT,
        hunger: 50,
        health: 100,
        rest_time_left: 0,
      };
      const payload = {
        method: 'step_many',
        params: {
          steps: [
            {
              sim_id: simId,
              dt: DT,
              fly,
              sources: [],
              pending: [],
            },
          ],
        },
      };
      const t0 = performance.now();
      const res = await sendRequest(sock, payload);
      const clientMs = performance.now() - t0;
      const item = res?.results?.[0] ?? {};
      perStepClient.push(clientMs);
      perStepCompute.push(Number(item.compute_ms ?? 0));
      perStepKernel.push(Number(item.kernel_ms ?? 0));
      perStepRecurrent.push(Number(item.recurrent_ms ?? 0));
      perStepLif.push(Number(item.lif_ms ?? 0));
      perStepReadout.push(Number(item.readout_ms ?? 0));
    }

    rows.push({
      run,
      create_ms: createMs,
      steps: STEPS,
      dt_s: DT,
      client_avg_ms: avg(perStepClient),
      client_p50_ms: median(perStepClient),
      compute_avg_ms: avg(perStepCompute),
      kernel_avg_ms: avg(perStepKernel),
      recurrent_avg_ms: avg(perStepRecurrent),
      lif_avg_ms: avg(perStepLif),
      readout_avg_ms: avg(perStepReadout),
    });
  }

  sock.end();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const header = [
    'run',
    'create_ms',
    'steps',
    'dt_s',
    'client_avg_ms',
    'client_p50_ms',
    'compute_avg_ms',
    'kernel_avg_ms',
    'recurrent_avg_ms',
    'lif_avg_ms',
    'readout_avg_ms',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((k) => row[k]).join(','));
  }
  fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n', 'utf8');

  console.log(`wrote ${OUT_CSV}`);
  for (const row of rows) {
    console.log(
      `run=${row.run} client_avg_ms=${row.client_avg_ms.toFixed(3)} compute_avg_ms=${row.compute_avg_ms.toFixed(3)} kernel_avg_ms=${row.kernel_avg_ms.toFixed(3)} recurrent_avg_ms=${row.recurrent_avg_ms.toFixed(3)} lif_avg_ms=${row.lif_avg_ms.toFixed(3)} readout_avg_ms=${row.readout_avg_ms.toFixed(3)}`,
    );
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

