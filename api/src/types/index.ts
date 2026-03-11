/**
 * Schemas for reward distribution and NeuroFly stats.
 * All data is kept in memory and persisted to JSON.
 */

/** Per-fly lifetime stats (owner, slot, birth, deploy, feed count) */
export interface NeuroFlyStats {
  address: string;
  slotIndex: number;
  timeBirthed: string;
  timeDeployed: string;
  feedCount: number;
}

/** Audit log entry for a past distribution */
export interface DistributedEntry {
  address: string;
  amountWei: string;
  timestamp: string;
}

/** Full persisted reward state (amounts as string for bigint serialization) */
export interface RewardState {
  pending: Record<string, string>;
  distributed: DistributedEntry[];
  neuroflyStats: NeuroFlyStats[];
}
