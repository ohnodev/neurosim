/**
 * Persistent store for deployed flies: address -> slotIndex -> simIndex.
 * Restored on startup; written on each deploy.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const deployPath = path.join(_dir, '../../data/deployments.json');

/** Persisted format: array of { address, slotIndex } in simIndex order */
interface DeploymentRecord {
  address: string;
  slotIndex: number;
}

let deployments: DeploymentRecord[] = [];

function load(): void {
  try {
    const raw = fs.readFileSync(deployPath, 'utf-8');
    const data = JSON.parse(raw);
    deployments = Array.isArray(data?.deployments) ? data.deployments : [];
  } catch {
    deployments = [];
  }
}

function save(): void {
  if (process.env.VITEST === 'true') return;
  try {
    fs.mkdirSync(path.dirname(deployPath), { recursive: true });
    fs.writeFileSync(deployPath, JSON.stringify({ deployments }, null, 2));
  } catch (err) {
    console.error('[deployStore] save error:', err);
  }
}

load();

export function getDeployments(): DeploymentRecord[] {
  return [...deployments];
}

export function addDeployment(address: string, slotIndex: number): void {
  const addr = address.toLowerCase();
  if (deployments.some((d) => d.address === addr && d.slotIndex === slotIndex)) return;
  deployments.push({ address: addr, slotIndex });
  save();
}

export function clearForTesting(): void {
  deployments = [];
  save();
}
