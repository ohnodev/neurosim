#!/usr/bin/env node
/**
 * World-loop GPU benchmark: measure brain-service world loop performance
 * with configurable fly counts. Captures profile output from the brain
 * service stderr log.
 *
 * Usage:
 *   node scripts/bench-world-gpu.mjs [--flies 1,3,10] [--duration 15] [--standalone]
 *
 * Options:
 *   --flies       Comma-separated fly counts to test (default: 1,3,10)
 *   --duration    Seconds to run each scenario (default: 15)
 *   --standalone  Stop PM2 services and run brain-service directly (required for nsight)
 *   --out         Output JSON path (default: logs/bench-world-gpu.json)
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const BRAIN_BIN = path.join(ROOT, 'api/brain-sim-service/target/release/brain-service');
const LOG_DIR = path.join(ROOT, 'logs');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { flies: [1, 3, 10], duration: 15, standalone: false, out: path.join(LOG_DIR, 'bench-world-gpu.json') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--flies' && args[i + 1]) {
      opts.flies = args[++i].split(',').map(Number).filter(n => n > 0);
    } else if (args[i] === '--duration' && args[i + 1]) {
      opts.duration = Number(args[++i]);
    } else if (args[i] === '--standalone') {
      opts.standalone = true;
    } else if (args[i] === '--out' && args[i + 1]) {
      opts.out = args[++i];
    }
  }
  return opts;
}

function sendRequest(sock, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.off('data', onData); reject(new Error('Request timeout')); }, timeoutMs);
    const msg = JSON.stringify(payload) + '\n';
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      clearTimeout(timer);
      const line = buf.slice(0, idx);
      sock.off('data', onData);
      try {
        const out = JSON.parse(line);
        if (out?.error) reject(new Error(out.error));
        else resolve(out);
      } catch (err) { reject(err); }
    };
    sock.on('data', onData);
    sock.write(msg, (err) => { if (err) { clearTimeout(timer); sock.off('data', onData); reject(err); } });
  });
}

async function connectSocket(retries = 20, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const sock = net.createConnection(SOCKET_PATH);
      await new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
      await sendRequest(sock, { method: 'ping' });
      return sock;
    } catch {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Could not connect to brain-service at ${SOCKET_PATH}`);
}

function parseProfileLine(line) {
  const m = {};
  const pairs = line.match(/[\w.]+=[^\s]+/g);
  if (!pairs) return null;
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq);
    let v = pair.slice(eq + 1);
    v = v.replace(/%$/, '');
    const num = parseFloat(v);
    m[k] = isNaN(num) ? v : num;
  }
  return m;
}

function findBrainLogPath() {
  const candidates = [
    path.join(LOG_DIR, 'neurosim-brain.log'),
  ];
  try {
    const files = fs.readdirSync(LOG_DIR);
    for (const f of files) {
      if (f.startsWith('neurosim-brain-') && f.endsWith('.log')) {
        candidates.unshift(path.join(LOG_DIR, f));
      }
    }
  } catch {}
  for (const p of candidates) {
    try { if (fs.statSync(p).size > 0) return p; } catch {}
  }
  return candidates[0];
}

async function runScenario(flyCount, durationSec, sock, brainLogPath) {
  console.log(`\n--- Scenario: ${flyCount} fly(s) for ${durationSec}s ---`);

  const truncateMark = brainLogPath ? fs.statSync(brainLogPath, { throwIfNoEntry: false })?.size || 0 : 0;

  const snap0 = await sendRequest(sock, { method: 'world_get_snapshot', params: { after_depletion_event_id: 0 } });
  const existingFlyIds = (snap0.flies || []).map(f => f.fly_id);
  for (const fid of existingFlyIds) {
    await sendRequest(sock, { method: 'world_remove_fly', params: { fly_id: fid } });
  }

  const flyIds = [];
  for (let i = 0; i < flyCount; i++) {
    const angle = (2 * Math.PI * i) / Math.max(flyCount, 1);
    const res = await sendRequest(sock, {
      method: 'world_add_fly',
      params: {
        fly: {
          x: Math.cos(angle) * 20,
          y: Math.sin(angle) * 20,
          z: 0.5,
          heading: angle,
          t: 0,
          hunger: 80,
          health: 100,
          rest_time_left: 0,
          dead: false,
        },
      },
    });
    flyIds.push(res.fly_id);
  }

  console.log(`  Deployed ${flyIds.length} flies: [${flyIds.join(', ')}]`);
  console.log(`  Waiting ${durationSec}s for profile data...`);
  await new Promise(r => setTimeout(r, durationSec * 1000));

  const profileEntries = [];
  if (brainLogPath && fs.existsSync(brainLogPath)) {
    const fd = fs.openSync(brainLogPath, 'r');
    const readBuf = Buffer.alloc(Math.max(fs.statSync(brainLogPath).size - truncateMark, 0));
    if (readBuf.length > 0) {
      fs.readSync(fd, readBuf, 0, readBuf.length, truncateMark);
    }
    fs.closeSync(fd);
    const logText = readBuf.toString('utf8');
    const lines = logText.split('\n');
    let currentBlock = '';
    for (const line of lines) {
      if (line.includes('[brain-service][world-loop] profile')) {
        if (currentBlock) {
          const parsed = parseProfileLine(currentBlock);
          if (parsed && parsed.active_batches > 0) profileEntries.push(parsed);
        }
        currentBlock = line;
      } else if (currentBlock && line.trim()) {
        currentBlock += ' ' + line.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\+\d{2}:\d{2}:\s*/, '').replace(/^\d+\|neuros\s*\|\s*/, '');
      }
    }
    if (currentBlock) {
      const parsed = parseProfileLine(currentBlock);
      if (parsed && parsed.active_batches > 0) profileEntries.push(parsed);
    }
  }

  for (const fid of flyIds) {
    await sendRequest(sock, { method: 'world_remove_fly', params: { fly_id: fid } });
  }

  if (profileEntries.length === 0) {
    console.log('  WARNING: no profile entries captured. Check brain service logs.');
    return { fly_count: flyCount, duration_sec: durationSec, profile_windows: 0, summary: null };
  }

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(arr.length, 1);

  const summary = {
    fly_count: flyCount,
    duration_sec: durationSec,
    profile_windows: profileEntries.length,
    avg_batch_ms: avg(profileEntries.map(p => p.avg_batch_ms || 0)),
    avg_phase_step_ms: avg(profileEntries.map(p => p.avg_phase_step_ms || 0)),
    avg_fly_step_total_ms: avg(profileEntries.map(p => p.avg_fly_step_total_ms || 0)),
    fly_step_fast_total_ms: avg(profileEntries.map(p => p.fly_step_fast_total_ms || 0)),
    fly_step_last_ms: avg(profileEntries.map(p => p.fly_step_last_ms || 0)),
    fly_microstep_loop_ms: avg(profileEntries.map(p => p.fly_microstep_loop_ms || 0)),
    fly_sources_clone_ms: avg(profileEntries.map(p => p.fly_sources_clone_ms || 0)),
    fly_bump_compute_ms: avg(profileEntries.map(p => p.fly_bump_compute_ms || 0)),
    fly_kinematics_ms: avg(profileEntries.map(p => p.fly_kinematics_ms || 0)),
    target_ms: profileEntries[0]?.target_ms || 0,
    overrun_pct: avg(profileEntries.map(p => p.overrun_pct || 0)),
    per_fly_avg_ms: avg(profileEntries.map(p => p.per_fly_avg_ms || 0)),
    per_fly_max_ms: avg(profileEntries.map(p => p.per_fly_max_ms || 0)),
    avg_flies: avg(profileEntries.map(p => p.avg_flies || 0)),
  };

  const targetMs = summary.target_ms || 125;
  const simRate = targetMs / Math.max(summary.avg_batch_ms, 0.001);

  summary.effective_sim_rate = simRate;
  summary.realtime = simRate >= 1.0;

  console.log(`  Results (avg over ${profileEntries.length} profile windows):`);
  console.log(`    target_ms:              ${summary.target_ms.toFixed(3)}`);
  console.log(`    avg_batch_ms:           ${summary.avg_batch_ms.toFixed(3)}`);
  console.log(`    avg_phase_step_ms:      ${summary.avg_phase_step_ms.toFixed(3)}`);
  console.log(`    fly_step_fast_total_ms: ${summary.fly_step_fast_total_ms.toFixed(3)}`);
  console.log(`    fly_microstep_loop_ms:  ${summary.fly_microstep_loop_ms.toFixed(3)}`);
  console.log(`    fly_sources_clone_ms:   ${summary.fly_sources_clone_ms.toFixed(3)}`);
  console.log(`    per_fly_avg_ms:         ${summary.per_fly_avg_ms.toFixed(3)}`);
  console.log(`    per_fly_max_ms:         ${summary.per_fly_max_ms.toFixed(3)}`);
  console.log(`    overrun_pct:            ${summary.overrun_pct.toFixed(1)}%`);
  console.log(`    effective_sim_rate:      ${simRate.toFixed(3)}x realtime`);

  return summary;
}

async function main() {
  const opts = parseArgs();
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const brainLogPath = findBrainLogPath();
  console.log(`Connecting to brain-service at ${SOCKET_PATH}...`);
  console.log(`Brain log: ${brainLogPath || '(not found)'}`);

  let sock;
  if (opts.standalone) {
    console.log('Standalone mode: stopping PM2 services and starting brain-service directly...');
    try { execSync('pm2 stop neurosim-brain neurosim-api 2>/dev/null', { stdio: 'ignore' }); } catch {}
    await new Promise(r => setTimeout(r, 1000));
    try { fs.unlinkSync(SOCKET_PATH); } catch {}

    const standaloneLog = path.join(LOG_DIR, 'neurosim-brain-standalone.log');
    const brainProc = spawn(BRAIN_BIN, [], {
      cwd: path.join(ROOT, 'api/brain-sim-service'),
      env: { ...process.env, USE_CUDA: '1', RUST_BACKTRACE: '1' },
      stdio: ['ignore', 'ignore', fs.openSync(standaloneLog, 'w')],
    });
    console.log(`  brain-service PID: ${brainProc.pid}, log: ${standaloneLog}`);
    sock = await connectSocket(40, 1000);
    console.log('  Connected.');

    const results = [];
    for (const fc of opts.flies) {
      const r = await runScenario(fc, opts.duration, sock, standaloneLog);
      results.push(r);
    }

    sock.end();
    brainProc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));

    fs.writeFileSync(opts.out, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
    console.log(`\nResults written to ${opts.out}`);
  } else {
    sock = await connectSocket();
    console.log('Connected to running brain-service.');

    const results = [];
    for (const fc of opts.flies) {
      const r = await runScenario(fc, opts.duration, sock, brainLogPath);
      results.push(r);
    }

    sock.end();
    fs.writeFileSync(opts.out, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
    console.log(`\nResults written to ${opts.out}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
