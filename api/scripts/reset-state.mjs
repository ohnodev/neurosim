#!/usr/bin/env node
/**
 * Reset API state to a fresh slate: flies, deployments, rewards, claims.
 * Does NOT touch raw connectome data or any other files in api/data.
 * Run from repo root: npm run reset-state (from api dir) or cd api && node scripts/reset-state.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const FILES = {
  'flies.json': {},
  'deployments.json': { deployments: [] },
  'rewards-state.json': {
    pending: {},
    inFlight: {},
    distributed: [],
    neuroflyStats: [],
  },
  'claims.json': { claims: {} },
};

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  try {
    for (const [filename, content] of Object.entries(FILES)) {
      const filePath = path.join(DATA_DIR, filename);
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
      console.log('Reset:', filename);
    }
    console.log('API state reset complete. Restart the API if it is running.');
  } catch (err) {
    console.error('reset-state failed:', err?.message ?? String(err));
    process.exit(1);
  }
}

main();
