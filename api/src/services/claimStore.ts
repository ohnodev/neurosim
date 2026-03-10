import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const JSONStore = require('json-store') as (path: string) => { get: (k: string) => unknown; set: (k: string, v: unknown) => void };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const claimsPath = path.join(__dirname, '../../data/claims.json');

const dataDir = path.dirname(claimsPath);
fs.mkdirSync(dataDir, { recursive: true });

const store = JSONStore(claimsPath);

export interface ClaimRecord {
  method: 'obelisk' | 'pay';
  txHash?: string;
  claimedAt: string;
}

function getClaims(): Record<string, ClaimRecord> {
  const data = store.get('claims');
  return (data && typeof data === 'object' ? data : {}) as Record<string, ClaimRecord>;
}

export function getClaim(address: string): ClaimRecord | undefined {
  const claims = getClaims();
  return claims[address.toLowerCase()];
}

let claimLock = false;
const lockQueue: Array<() => void> = [];

async function withClaimLock<T>(fn: () => T): Promise<T> {
  while (claimLock) {
    await new Promise<void>((resolve) => lockQueue.push(resolve));
  }
  claimLock = true;
  try {
    return fn();
  } finally {
    claimLock = false;
    const next = lockQueue.shift();
    if (next) next();
  }
}

/**
 * Atomically check and set a claim. Returns true if claim was recorded, false if already claimed.
 */
export async function tryClaim(address: string, record: ClaimRecord): Promise<boolean> {
  return withClaimLock(() => {
    const addr = address.toLowerCase();
    const existing = getClaim(addr);
    if (existing) return false;
    const claims = getClaims();
    claims[addr] = record;
    store.set('claims', claims);
    return true;
  });
}

export async function setClaim(address: string, record: ClaimRecord): Promise<void> {
  return withClaimLock(() => {
    const addr = address.toLowerCase();
    const claims = getClaims();
    claims[addr] = record;
    store.set('claims', claims);
  });
}
