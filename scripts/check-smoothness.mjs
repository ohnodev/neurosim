#!/usr/bin/env node
/**
 * Fetch position samples from API and validate smoothness.
 * Requires: API running with DEBUG_POSITIONS=1, world open at ?debugPositions=1
 */
import http from 'http';

const BASE = 'http://localhost:3001';
const MIN_SAMPLES = 50;
const T_DISPLAY_EPS = 1e-9;
const DELTA_MIN = 0.001;
const DELTA_MAX = 0.1;
const MAX_POS_JUMP = 1;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} (start API with DEBUG_POSITIONS=1)`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON: ' + data.slice(0, 100)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function main() {
  const failures = [];

  const { samples } = await fetchJson(`${BASE}/api/debug/positions?clear=1`).catch((e) => {
    console.error('Failed to fetch positions:', e.message);
    console.error('Ensure API is running with DEBUG_POSITIONS=1 and world is open at ?debugPositions=1');
    process.exit(1);
  });

  if (!Array.isArray(samples) || samples.length < MIN_SAMPLES) {
    console.error(`Need at least ${MIN_SAMPLES} samples, got ${samples?.length ?? 0}`);
    process.exit(1);
  }

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const tPrev = prev.tDisplay ?? 0;
    const tCurr = curr.tDisplay ?? 0;
    const delta = curr.delta ?? 0;

    if (tCurr < tPrev - T_DISPLAY_EPS) {
      failures.push(`tDisplay non-monotonic at sample ${i}: ${tPrev.toFixed(4)} -> ${tCurr.toFixed(4)}`);
    }
    if (delta < DELTA_MIN || delta > DELTA_MAX) {
      failures.push(`delta out of bounds [${DELTA_MIN},${DELTA_MAX}] at sample ${i}: ${delta.toFixed(4)}`);
    }
    const a = curr.alpha ?? 0;
    if (a < 0 || a > 1) {
      failures.push(`alpha out of [0,1] at sample ${i}: ${a.toFixed(4)}`);
    }
    const dx = Math.abs((curr.x ?? 0) - (prev.x ?? 0));
    const dy = Math.abs((curr.y ?? 0) - (prev.y ?? 0));
    const dz = Math.abs((curr.z ?? 0) - (prev.z ?? 0));
    if (dx > MAX_POS_JUMP || dy > MAX_POS_JUMP || dz > MAX_POS_JUMP) {
      failures.push(`position jump at sample ${i}: dx=${dx.toFixed(4)} dy=${dy.toFixed(4)} dz=${dz.toFixed(4)}`);
    }
  }

  if (failures.length > 0) {
    console.error('Smoothness check FAILED:');
    failures.slice(0, 10).forEach((f) => { console.error('  ' + f); });
    if (failures.length > 10) console.error(`  ... and ${failures.length - 10} more`);
    process.exit(1);
  }

  console.log(`Smoothness OK: ${samples.length} samples`);
  process.exit(0);
}

main();
