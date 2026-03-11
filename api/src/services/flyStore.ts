/**
 * In-memory store for NeuroFlies. Users can have up to 3 flies.
 * Persisted to single data path (see lib/dataPath).
 */
import fs from 'fs';
import path from 'path';
import { dataPath } from '../lib/dataPath.js';

const fliesPath = dataPath('flies.json');

export interface NeuroFly {
  id: string;
  method: 'obelisk' | 'pay';
  txHash?: string;
  claimedAt: string;
  seed?: number;
}

let fliesByAddress: Record<string, NeuroFly[]> = {};

function load(): void {
  try {
    const raw = fs.readFileSync(fliesPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      fliesByAddress = data;
    }
  } catch {
    fliesByAddress = {};
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(fliesPath), { recursive: true });
    fs.writeFileSync(fliesPath, JSON.stringify(fliesByAddress, null, 2));
  } catch (err) {
    console.error('[flyStore] save error:', err);
  }
}

load();

const MAX_FLIES = 3;

export function getFlies(address: string): NeuroFly[] {
  const addr = address.toLowerCase();
  const list = fliesByAddress[addr] ?? [];
  return Array.isArray(list) ? list : [];
}

export function addFly(address: string, fly: Omit<NeuroFly, 'id'>): NeuroFly | null {
  const addr = address.toLowerCase();
  const existing = getFlies(addr);
  if (existing.length >= MAX_FLIES) return null;
  const id = `${addr}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full: NeuroFly = { ...fly, id };
  fliesByAddress[addr] = [...existing, full];
  save();
  return full;
}

export function canClaimObelisk(address: string): boolean {
  const flies = getFlies(address);
  const hasObelisk = flies.some((f) => f.method === 'obelisk');
  return !hasObelisk && flies.length < MAX_FLIES;
}
