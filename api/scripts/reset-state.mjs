#!/usr/bin/env node
/**
 * Reset API state to a fresh slate: flies, deployments, rewards, claims.
 * Only touches the API's own data folder (api/data). Does NOT touch the repo
 * root "data" folder (connectome subset, raw data, etc.).
 * Run: cd api && npm run reset-state  OR  node api/scripts/reset-state.mjs from repo root.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(API_DIR, 'data');

// Ensure we only ever write to api/data, never to repo root data/
if (path.basename(API_DIR) !== 'api') {
  console.error('reset-state: expected to run from api/scripts; API_DIR basename is not "api". Aborting.');
  process.exit(1);
}

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
  'dead-letter.json': { entries: [] },
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
