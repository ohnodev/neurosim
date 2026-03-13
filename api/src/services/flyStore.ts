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

export type FlySlot = NeuroFly | null;
let fliesByAddress: Record<string, FlySlot[]> = {};
const MAX_FLIES = 3;

function load(): void {
  try {
    const raw = fs.readFileSync(fliesPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      const normalized: Record<string, FlySlot[]> = {};
      for (const [addr, value] of Object.entries(data as Record<string, unknown>)) {
        const arr = Array.isArray(value) ? value : [];
        const slots: FlySlot[] = [null, null, null];
        for (let i = 0; i < Math.min(MAX_FLIES, arr.length); i++) {
          const item = arr[i];
          if (
            item &&
            typeof item === 'object' &&
            typeof (item as NeuroFly).id === 'string' &&
            typeof (item as NeuroFly).method === 'string' &&
            typeof (item as NeuroFly).claimedAt === 'string'
          ) {
            slots[i] = item as NeuroFly;
          }
        }
        normalized[addr.toLowerCase()] = slots;
      }
      fliesByAddress = normalized;
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

export function getFlies(address: string): FlySlot[] {
  const addr = address.toLowerCase();
  const list = fliesByAddress[addr];
  if (!Array.isArray(list)) return [null, null, null];
  const out: FlySlot[] = [null, null, null];
  for (let i = 0; i < MAX_FLIES; i++) out[i] = list[i] ?? null;
  return out;
}

export function addFly(address: string, fly: Omit<NeuroFly, 'id'>): NeuroFly | null {
  const addr = address.toLowerCase();
  const existing = getFlies(addr);
  const emptySlot = existing.findIndex((f) => f == null);
  if (emptySlot === -1) return null;
  const id = `${addr}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full: NeuroFly = { ...fly, id };
  existing[emptySlot] = full;
  fliesByAddress[addr] = existing;
  save();
  return full;
}

export function removeFlyAtSlot(address: string, slotIndex: number): NeuroFly | null {
  const addr = address.toLowerCase();
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_FLIES) return null;
  const existing = getFlies(addr);
  const removed = existing[slotIndex];
  if (!removed) return null;
  existing[slotIndex] = null;
  fliesByAddress[addr] = existing;
  save();
  return removed;
}

export function getActiveFlyCount(address: string): number {
  return getFlies(address).filter(Boolean).length;
}

export function canClaimObelisk(address: string): boolean {
  const flies = getFlies(address);
  const hasObelisk = flies.some((f) => f?.method === 'obelisk');
  return !hasObelisk && flies.filter(Boolean).length < MAX_FLIES;
}
