import { getApiBase } from './constants';
import type { WorldSource } from '../../../api/src/world';

export const apiKeys = {
  all: ['api'] as const,
  world: () => [...apiKeys.all, 'world'] as const,
  neurons: () => [...apiKeys.all, 'neurons'] as const,
  myFlies: (address: string) => [...apiKeys.all, 'my-flies', address] as const,
  myDeployed: (address: string) => [...apiKeys.all, 'my-deployed', address] as const,
  flyStats: (address: string) => [...apiKeys.all, 'fly-stats', address] as const,
  rewardsHistory: () => [...apiKeys.all, 'rewards-history'] as const,
};

export interface ClaimedFly {
  id: string;
  method: string;
  claimedAt: string;
}

export interface FlyStatsData {
  stats: { slotIndex: number; feedCount: number }[];
  rewardPerPointWei: string;
}

const FALLBACK_WEI = (1000n * 10n ** 18n).toString();

export async function fetchWorld(): Promise<{ sources: WorldSource[] }> {
  const r = await fetch(`${getApiBase()}/api/world`);
  if (!r.ok) throw new Error(r.statusText || 'Failed to fetch world');
  const d = await r.json();
  if (!Array.isArray(d.sources)) throw new Error('Invalid /api/world response');
  return { sources: d.sources };
}

export interface NeuronRaw {
  root_id: string;
  role?: string;
  cell_type?: string;
  x?: number;
  y?: number;
  z?: number;
}

export async function fetchNeurons(): Promise<{ neurons: NeuronRaw[] }> {
  const r = await fetch(`${getApiBase()}/api/neurons`);
  if (!r.ok) throw new Error(r.statusText || 'Failed to fetch neurons');
  const d = await r.json();
  if (!Array.isArray(d.neurons)) throw new Error('Invalid /api/neurons response');
  return { neurons: d.neurons };
}

export async function fetchMyFlies(address: string): Promise<ClaimedFly[]> {
  const r = await fetch(`${getApiBase()}/api/claim/my-flies?address=${address.toLowerCase()}`);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.flies ?? []) as ClaimedFly[];
}

export async function fetchMyDeployed(address: string): Promise<Record<number, number>> {
  const r = await fetch(`${getApiBase()}/api/deploy/my-deployed?address=${address.toLowerCase()}`);
  if (!r.ok) return {};
  const data = await r.json();
  return data.deployed ?? {};
}

export async function fetchFlyStats(address: string): Promise<FlyStatsData> {
  const r = await fetch(`${getApiBase()}/api/rewards/stats?address=${address.toLowerCase()}`);
  if (!r.ok) return { stats: [], rewardPerPointWei: FALLBACK_WEI };
  const data = await r.json();
  return {
    stats: data.stats ?? [],
    rewardPerPointWei: data.rewardPerPointWei ?? FALLBACK_WEI,
  };
}
