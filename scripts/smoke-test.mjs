#!/usr/bin/env node
/**
 * Smoke test: API health, Vite build, PM2 status
 */
import { spawnSync } from 'child_process';
import http from 'http';

const BASE = 'http://localhost:3001';

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  let ok = 0;
  let fail = 0;

  // 1. API health (if running)
  try {
    const r = await get(`${BASE}/api/health`);
    if (r.status === 200 && r.data.includes('ok')) {
      console.log('✓ API health OK');
      ok++;
    } else {
      console.log('✗ API health failed (is API running on 3001?)');
      fail++;
    }
  } catch (e) {
    console.log('⚠ API not reachable (start with: cd api && npm run dev)');
  }

  // 2. Vite build
  const vite = spawnSync('npm', ['run', 'build'], { cwd: 'web', stdio: 'pipe', encoding: 'utf-8' });
  if (vite.status === 0) {
    console.log('✓ Vite build OK');
    ok++;
  } else {
    console.log('✗ Vite build failed');
    if (vite.stderr) console.log(vite.stderr.slice(-300));
    fail++;
  }

  // 3. PM2 status (optional)
  const pm2 = spawnSync('pm2', ['list'], { stdio: 'pipe', encoding: 'utf-8' });
  if (pm2.status === 0 && pm2.stdout.includes('neurosim-api')) {
    console.log('✓ PM2 neurosim-api present');
    ok++;
  } else {
    console.log('⚠ PM2 neurosim-api not running (run: ./pm2-manager.sh start)');
  }

  console.log(`\nSmoke: ${ok} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
