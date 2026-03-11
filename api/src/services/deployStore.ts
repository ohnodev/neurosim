/**
 * Persistent store for deployed flies: address -> slotIndex -> simIndex.
 * Restored on startup; written on each deploy.
 * Uses single data path (see lib/dataPath).
 */
import fs from 'fs';
import path from 'path';
import { dataPath } from '../lib/dataPath.js';

const deployPath = dataPath('deployments.json');

/** Persisted format: array of { address, slotIndex, timeDeployed? } in simIndex order */
export interface DeploymentRecord {
  address: string;
  slotIndex: number;
  timeDeployed?: string;
}

let deployments: DeploymentRecord[] = [];

function load(): void {
  try {
    const raw = fs.readFileSync(deployPath, 'utf-8');
    const data = JSON.parse(raw);
    const arr = Array.isArray(data?.deployments) ? data.deployments : [];
    deployments = arr.map((d: { address: string; slotIndex: number; timeDeployed?: string }) => ({
      address: d.address?.toLowerCase() ?? d.address,
      slotIndex: d.slotIndex,
      timeDeployed: d.timeDeployed,
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
  if (deployments.some((d) => d.address === addr && d.slotIndex === slotIndex)) return;
  deployments.push({
    address: addr,
    slotIndex,
    timeDeployed: new Date().toISOString(),
  });
  save();
}

export function clearForTesting(): void {
  deployments = [];
  save();
}
