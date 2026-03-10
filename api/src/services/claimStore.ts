import path from 'path';
import { fileURLToPath } from 'url';

// json-store uses require - we need CommonJS interop
// eslint-disable-next-line @typescript-eslint/no-require-imports
const JSONStore = require('json-store');

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
  return data && typeof data === 'object' ? data : {};
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
