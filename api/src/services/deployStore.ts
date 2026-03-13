/**
 * Persistent store for deployed flies: address -> slotIndex -> simIndex.
 * Restored on startup; written on each deploy.
 * Uses single data path (see lib/dataPath).
 */
import fs from 'fs';
import path from 'path';
import { dataPath } from '../lib/dataPath.js';
import { getFlies } from './flyStore.js';

const deployPath = dataPath('deployments.json');

/** Persisted format: array of { address, slotIndex, flyId?, timeDeployed? } in simIndex order */
export interface DeploymentRecord {
  address: string;
  slotIndex: number;
  /** Identifies which fly is deployed; new fly in same slot => 0 points until deployed */
  flyId?: string;
  timeDeployed?: string;
  active?: boolean;
}

let deployments: DeploymentRecord[] = [];

function load(): void {
  try {
    const raw = fs.readFileSync(deployPath, 'utf-8');
    const data = JSON.parse(raw);
    const arr = Array.isArray(data?.deployments) ? data.deployments : [];
    deployments = arr.map((d: { address: string; slotIndex: number; flyId?: string; timeDeployed?: string; active?: boolean }) => ({
      address: d.address?.toLowerCase() ?? d.address,
      slotIndex: d.slotIndex,
      flyId: d.flyId,
      timeDeployed: d.timeDeployed,
      active: d.active ?? true,
    }));
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
  if (deployments.some((d) => d.active !== false && d.address === addr && d.slotIndex === slotIndex)) return;
  const flies = getFlies(addr);
  // Flies array index = slot (flies appended in claim order: first claim => slot 0, etc.)
  const fly = flies[slotIndex];
  const flyId = fly?.id;
  if (!flyId || typeof flyId !== 'string') {
    throw new Error(`[deployStore] Cannot add deployment: no fly at slot ${slotIndex} for ${addr}`);
  }
  deployments.push({
    address: addr,
    slotIndex,
    flyId,
    timeDeployed: new Date().toISOString(),
    active: true,
  });
  save();
}

export function deactivateDeployment(address: string, slotIndex: number): void {
  const addr = address.toLowerCase();
  const rec = deployments.find((d) => d.active !== false && d.address === addr && d.slotIndex === slotIndex);
  if (!rec) return;
  rec.active = false;
  save();
}

export function clearForTesting(): void {
  deployments = [];
  save();
}
