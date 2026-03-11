/**
 * In-memory reward store with JSON persistence.
 * Tracks pending rewards per owner, NeuroFly stats, and distributed history.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { NeuroFlyStats, RewardState } from '../types/index.js';
import { getDeployments } from './deployStore.js';
import { getFlies } from './flyStore.js';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const rewardsPath = path.join(_dir, '../../data/rewards-state.json');

/** 0.000001 ETH per food collected */
export const REWARD_PER_FOOD = 10n ** 12n;

let pending = new Map<string, bigint>();
let neuroflyStats: NeuroFlyStats[] = [];
let distributed: RewardState['distributed'] = [];

function load(): void {
  try {
    const raw = fs.readFileSync(rewardsPath, 'utf-8');
    const data = JSON.parse(raw) as RewardState;
    pending = new Map(Object.entries(data?.pending ?? {}).map(([k, v]) => [k, BigInt(v)]));
    neuroflyStats = Array.isArray(data?.neuroflyStats) ? data.neuroflyStats : [];
    distributed = Array.isArray(data?.distributed) ? data.distributed : [];
  } catch {
    pending = new Map();
    neuroflyStats = [];
    distributed = [];
  }
}

function save(): void {
  if (process.env.VITEST === 'true') return;
  try {
    fs.mkdirSync(path.dirname(rewardsPath), { recursive: true });
    const state: RewardState = {
      pending: Object.fromEntries([...pending].map(([k, v]) => [k, v.toString()])),
      distributed,
      neuroflyStats,
    };
    fs.writeFileSync(rewardsPath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[rewardStore] save error:', err);
  }
}

load();

function findStats(address: string, slotIndex: number): NeuroFlyStats | undefined {
  const addr = address.toLowerCase();
  return neuroflyStats.find((s) => s.address === addr && s.slotIndex === slotIndex);
}

function getOrCreateStats(address: string, slotIndex: number): NeuroFlyStats {
  const addr = address.toLowerCase();
  const existing = findStats(addr, slotIndex);
  if (existing) return existing;

  const flies = getFlies(addr);
  const fly = flies[slotIndex];
  const deployRecords = getDeployments();
  const deployRecord = deployRecords.find((d) => d.address === addr && d.slotIndex === slotIndex);

  const stats: NeuroFlyStats = {
    address: addr,
    slotIndex,
    timeBirthed: fly?.claimedAt ?? new Date().toISOString(),
    timeDeployed: deployRecord?.timeDeployed ?? new Date().toISOString(),
    feedCount: 0,
  };
  neuroflyStats.push(stats);
  return stats;
}

/**
 * Record that the fly at simIndex collected food. Resolves owner, adds reward, increments feedCount.
 */
export function recordFoodCollected(simIndex: number): void {
  const deployments = getDeployments();
  const record = deployments[simIndex];
  if (!record) return;

  const { address, slotIndex } = record;
  const addr = address.toLowerCase();

  const stats = getOrCreateStats(addr, slotIndex);
  stats.feedCount += 1;

  const current = pending.get(addr) ?? 0n;
  pending.set(addr, current + REWARD_PER_FOOD);

  save();
}

/**
 * Get pending rewards for flush. Returns recipients and amounts (non-zero only).
 */
export function getPendingForFlush(): { recipients: string[]; amounts: bigint[] } {
  const recipients: string[] = [];
  const amounts: bigint[] = [];
  for (const [addr, amt] of pending) {
    if (amt > 0n) {
      recipients.push(addr);
      amounts.push(amt);
    }
  }
  return { recipients, amounts };
}

/**
 * Mark rewards as distributed. Clears pending for those addresses and appends to history.
 */
export function markDistributed(recipients: string[], amounts: bigint[]): void {
  const now = new Date().toISOString();
  for (let i = 0; i < recipients.length; i++) {
    const addr = recipients[i].toLowerCase();
    const amt = amounts[i];
    pending.set(addr, 0n);
    distributed.push({ address: addr, amountWei: amt.toString(), timestamp: now });
  }
  save();
}

export function getNeuroFlyStats(address: string, slotIndex: number): NeuroFlyStats | undefined {
  return findStats(address, slotIndex);
}

export function clearForTesting(): void {
  pending.clear();
  neuroflyStats = [];
  distributed = [];
  save();
}
