import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const JSONStore = require('json-store') as (path: string) => { get: (k: string) => unknown; set: (k: string, v: unknown) => void };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const claimsPath = path.join(__dirname, '../../data/claims.json');

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

export function setClaim(address: string, record: ClaimRecord): void {
  const claims = getClaims();
  claims[address.toLowerCase()] = record;
  store.set('claims', claims);
}
