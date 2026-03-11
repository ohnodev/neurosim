/**
 * Schemas for reward distribution and NeuroFly stats.
 * All data is kept in memory and persisted to JSON.
 */

/** Per-fly lifetime stats (keyed by fly id so a new fly in the same slot starts at 0 points). */
export interface NeuroFlyStats {
  address: string;
  slotIndex: number;
  flyId: string;
  timeBirthed: string;
  timeDeployed: string;
  feedCount: number;
}

/** Audit log entry for a past distribution */
export interface DistributedEntry {
  address: string;
  amountWei: string;
  timestamp: string;
  /** Transaction hash on Base (if recorded) */
  txHash?: string;
}

/** Full persisted reward state (amounts as string for bigint serialization) */
export interface RewardState {
  pending: Record<string, string>;
  /** In-flight batch taken by takeBatchForFlush; restored on load and merged back to pending. */
  inFlight?: Record<string, string>;
  distributed: DistributedEntry[];
  neuroflyStats: NeuroFlyStats[];
}
