/**
 * In-memory reward store with JSON persistence.
 * Tracks pending rewards per owner, NeuroFly stats, and distributed history.
 * Persistence uses write-to-temp-then-rename for atomic writes (openclaw-style).
 * Uses single data path (see lib/dataPath).
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { NeuroFlyStats, RewardState } from '../types/index.js';
import { getDeployments } from './deployStore.js';
import { getFlies } from './flyStore.js';
import { dataPath } from '../lib/dataPath.js';

const rewardsPath = dataPath('rewards-state.json');
const deadLetterPath = dataPath('dead-letter.json');

/** 100 $NEURO (18 decimals) per food collected */
export const REWARD_PER_FOOD = 100n * 10n ** 18n;

/** Number of NeuroFly slots per address */
export const MAX_SLOTS = 3;

/** Max distributed history entries to keep in memory */
const MAX_DISTRIBUTED_HISTORY = 10_000;

let pending = new Map<string, bigint>();
let inFlight = new Map<string, bigint>();
let neuroflyStats: NeuroFlyStats[] = [];
let distributed: RewardState['distributed'] = [];

let saveScheduled: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 500;

function load(): void {
  try {
    const raw = readFileSync(rewardsPath, 'utf-8');
    const data = JSON.parse(raw) as RewardState;
    pending = new Map(Object.entries(data?.pending ?? {}).map(([k, v]) => [k, BigInt(v)]));
    const restoredInFlight = new Map(
      Object.entries(data?.inFlight ?? {}).map(([k, v]) => [k, BigInt(v)])
    );
    // Merge inFlight back into pending so no rewards are lost after a crash (batch may not have been sent).
    for (const [addr, amt] of restoredInFlight) {
      const current = pending.get(addr) ?? 0n;
      pending.set(addr, current + amt);
    }
    inFlight = new Map();
    neuroflyStats = (Array.isArray(data?.neuroflyStats) ? data.neuroflyStats : []).filter(
      (s): s is NeuroFlyStats => typeof (s as NeuroFlyStats).flyId === 'string'
    );
    distributed = Array.isArray(data?.distributed) ? data.distributed : [];
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code !== 'ENOENT') {
      console.error('[rewardStore] load error reading', rewardsPath, nodeErr);
    }
    pending = new Map();
    inFlight = new Map();
    neuroflyStats = [];
    distributed = [];
  }
}

async function persist(): Promise<void> {
  if (process.env.VITEST === 'true') return;
  const state: RewardState = {
    pending: Object.fromEntries([...pending].map(([k, v]) => [k, v.toString()])),
    inFlight: Object.fromEntries([...inFlight].map(([k, v]) => [k, v.toString()])),
    distributed,
    neuroflyStats,
  };
  const data = `${JSON.stringify(state, null, 2)}\n`;
  const dir = path.dirname(rewardsPath);
  const tmp = path.join(dir, `${path.basename(rewardsPath)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, data, { encoding: 'utf-8' });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, rewardsPath);
  } catch (err) {
    console.error('[rewardStore] save error:', err);
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore cleanup failure
    }
  }
}

function save(): void {
  if (process.env.VITEST === 'true') return;
  if (saveScheduled) clearTimeout(saveScheduled);
  saveScheduled = setTimeout(() => {
    saveScheduled = null;
    void persist();
  }, SAVE_DEBOUNCE_MS);
}

load();

export interface DeadLetterEntry {
  id: string;
  address: string;
  amountWei: string;
  error: string;
  timestamp: string;
}

function loadDeadLetter(): DeadLetterEntry[] {
  try {
    const raw = readFileSync(deadLetterPath, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

/**
 * Persist a dead-letter entry for audit/replay. Call before dropFromInFlight.
 */
export function persistDeadLetterEntry(address: string, amountWei: bigint, error: unknown): void {
  if (process.env.VITEST === 'true') return;
  const entries = loadDeadLetter();
  const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const errMsg = error instanceof Error ? error.message : String(error);
  entries.push({
    id,
    address: address.toLowerCase(),
    amountWei: amountWei.toString(),
    error: errMsg,
    timestamp: new Date().toISOString(),
  });
  const dir = path.dirname(deadLetterPath);
  const tmp = path.join(dir, `${path.basename(deadLetterPath)}.${crypto.randomUUID()}.tmp`);
  try {
    const data = `${JSON.stringify({ entries }, null, 2)}\n`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, data, 'utf-8');
    chmodSync(tmp, 0o600);
    renameSync(tmp, deadLetterPath);
  } catch (err) {
    console.error('[rewardStore] persistDeadLetterEntry failed:', err);
    throw err;
  }
}

function findStats(address: string, slotIndex: number, flyId: string): NeuroFlyStats | undefined {
  const addr = address.toLowerCase();
  return neuroflyStats.find(
    (s) => s.address === addr && s.slotIndex === slotIndex && s.flyId === flyId
  );
}

function getOrCreateStats(address: string, slotIndex: number, flyId: string): NeuroFlyStats {
  const addr = address.toLowerCase();
  const existing = findStats(addr, slotIndex, flyId);
  if (existing) return existing;

  const flies = getFlies(addr);
  const fly = flies[slotIndex];
  const deployRecords = getDeployments();
  const deployRecord = deployRecords.find((d) => d.active !== false && d.address === addr && d.slotIndex === slotIndex);

  const stats: NeuroFlyStats = {
    address: addr,
    slotIndex,
    flyId,
    timeBirthed: fly?.claimedAt ?? new Date().toISOString(),
    timeDeployed: deployRecord?.timeDeployed ?? new Date().toISOString(),
    feedCount: 0,
  };
  neuroflyStats.push(stats);
  return stats;
}

/**
 * Record that the fly at simIndex collected food. Resolves owner and fly id, adds reward, increments feedCount for that fly.
 */
export function recordFoodCollected(simIndex: number): void {
  const deployments = getDeployments();
  const record = deployments[simIndex];
  if (!record) return;
  if (record.active === false) return;

  const { address, slotIndex } = record;
  const addr = address.toLowerCase();
  const flyId = record.flyId ?? getFlies(addr)[slotIndex]?.id;
  if (!flyId) return;

  const stats = getOrCreateStats(addr, slotIndex, flyId);
  stats.feedCount += 1;

  const current = pending.get(addr) ?? 0n;
  pending.set(addr, current + REWARD_PER_FOOD);

  save();
}

/**
 * Atomically move up to maxCount pending rewards to in-flight and return the batch.
 * Call confirmDistributed on success, rollbackBatch on failure.
 * @param maxCount - Max recipients to take (default no limit).
 */
export function takeBatchForFlush(maxCount?: number): { recipients: string[]; amounts: bigint[] } {
  const recipients: string[] = [];
  const amounts: bigint[] = [];
  const limit = maxCount != null && maxCount > 0 ? maxCount : Number.POSITIVE_INFINITY;
  for (const [addr, amt] of pending) {
    if (recipients.length >= limit) break;
    if (amt > 0n) {
      recipients.push(addr);
      amounts.push(amt);
      inFlight.set(addr, amt);
      pending.delete(addr);
    }
  }
  if (recipients.length > 0) save();
  return { recipients, amounts };
}

/**
 * Confirm distribution succeeded. Removes from in-flight, appends to history.
 * @param txHash - Optional transaction hash for the batch (shared by all entries).
 */
export function confirmDistributed(recipients: string[], amounts: bigint[], txHash?: string): void {
  if (recipients.length !== amounts.length) {
    throw new Error(`[rewardStore] confirmDistributed: recipients.length (${recipients.length}) !== amounts.length (${amounts.length})`);
  }
  const now = new Date().toISOString();
  for (let i = 0; i < recipients.length; i++) {
    const addr = recipients[i].toLowerCase();
    const amt = amounts[i];
    if (amt === undefined) throw new Error(`[rewardStore] confirmDistributed: undefined amount at index ${i}`);
    inFlight.delete(addr);
    distributed.push({ address: addr, amountWei: amt.toString(), timestamp: now, txHash });
  }
  if (distributed.length > MAX_DISTRIBUTED_HISTORY) {
    distributed = distributed.slice(-MAX_DISTRIBUTED_HISTORY);
  }
  save();
}

/**
 * Drop recipients from in-flight without putting back to pending (e.g. dead-letter).
 * Throws if recipients.length !== amounts.length to surface bookkeeping bugs.
 */
export function dropFromInFlight(recipients: string[], amounts: bigint[]): void {
  if (recipients.length !== amounts.length) {
    throw new Error(
      `[rewardStore] dropFromInFlight: recipients.length (${recipients.length}) !== amounts.length (${amounts.length})`
    );
  }
  for (let i = 0; i < recipients.length; i++) {
    const addr = recipients[i].toLowerCase();
    inFlight.delete(addr);
  }
  save();
}

/**
 * Rollback a failed distribution: put amounts back into pending.
 */
export function rollbackBatch(recipients: string[], amounts: bigint[]): void {
  if (recipients.length !== amounts.length) {
    throw new Error(`rollbackBatch: recipients.length (${recipients.length}) !== amounts.length (${amounts.length})`);
  }
  for (let i = 0; i < recipients.length; i++) {
    const addr = recipients[i].toLowerCase();
    const amt = amounts[i];
    if (amt !== undefined) {
      inFlight.delete(addr);
      const current = pending.get(addr) ?? 0n;
      pending.set(addr, current + amt);
    }
  }
  save();
}

export function getNeuroFlyStats(
  address: string,
  slotIndex: number,
  flyId: string
): NeuroFlyStats | undefined {
  return findStats(address.toLowerCase(), slotIndex, flyId);
}

/** Stats per slot for current flies only. New fly in a slot => 0 points until it earns. */
export function getStatsForAddress(address: string): { slotIndex: number; feedCount: number }[] {
  const addr = address.toLowerCase();
  const flies = getFlies(addr);
  const result: { slotIndex: number; feedCount: number }[] = [];
  for (let slotIndex = 0; slotIndex < MAX_SLOTS; slotIndex++) {
    const fly = flies[slotIndex];
    const feedCount = fly
      ? (findStats(addr, slotIndex, fly.id)?.feedCount ?? 0)
      : 0;
    result.push({ slotIndex, feedCount });
  }
  return result;
}

/** Last N distributed entries (most recent last). Default 50. */
export function getDistributedHistory(limit = 50): RewardState['distributed'] {
  const len = distributed.length;
  if (len <= limit) return [...distributed];
  return distributed.slice(-limit);
}

export function clearForTesting(): void {
  pending.clear();
  inFlight.clear();
  neuroflyStats = [];
  distributed = [];
  save();
}
