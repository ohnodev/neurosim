import { getApiBase } from './constants';
import type { WorldSource } from '../../../api/src/world';

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export const apiKeys = {
  all: ['api'] as const,
  world: () => [...apiKeys.all, 'world'] as const,
  neurons: () => [...apiKeys.all, 'neurons'] as const,
  myFlies: (address: string) => [...apiKeys.all, 'my-flies', normalizeAddress(address)] as const,
  myDeployed: (address: string) => [...apiKeys.all, 'my-deployed', normalizeAddress(address)] as const,
  flyStats: (address: string) => [...apiKeys.all, 'fly-stats', normalizeAddress(address)] as const,
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

export interface MyDeployedData {
  deployed: Record<number, number>;
  graveyardSlots: number[];
}

export interface GraveyardFlyEntry {
  flyId: string;
  slotIndex: number;
  feedCount: number;
  rewardWei: string;
  timeBirthed?: string;
  timeDeployed?: string;
  removedAt?: string | null;
}

export interface GraveyardPageData {
  items: GraveyardFlyEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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

export async function fetchMyFlies(address: string): Promise<Array<ClaimedFly | null>> {
  const enc = encodeURIComponent(normalizeAddress(address));
  const url = `${getApiBase()}/api/claim/my-flies?address=${enc}`;
  let r: Response;
  try {
    r = await fetch(url);
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('[api] fetchMyFlies network error:', err, url);
    throw err;
  }
  if (!r.ok) {
    if (import.meta.env?.DEV) console.warn('[api] fetchMyFlies failed:', r.status, r.statusText, url);
    throw new Error(`My flies failed: ${r.status} ${r.statusText}`);
  }
  const data = await r.json();
  const raw = data.flies;
  if (!Array.isArray(raw)) return [null, null, null];
  const out: Array<ClaimedFly | null> = [null, null, null];
  for (let i = 0; i < 3; i++) {
    const item = raw[i];
    if (item != null && typeof item === 'object' && typeof item.id === 'string' && typeof item.method === 'string' && typeof item.claimedAt === 'string') {
      out[i] = { id: item.id, method: item.method, claimedAt: item.claimedAt };
    }
  }
  return out;
}

export async function fetchMyDeployed(address: string): Promise<MyDeployedData> {
  const enc = encodeURIComponent(normalizeAddress(address));
  const url = `${getApiBase()}/api/deploy/my-deployed?address=${enc}`;
  let r: Response;
  try {
    r = await fetch(url);
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('[api] fetchMyDeployed network error:', err, url);
    throw err;
  }
  if (!r.ok) {
    if (import.meta.env?.DEV) console.warn('[api] fetchMyDeployed failed:', r.status, r.statusText, url);
    throw new Error(`My deployed failed: ${r.status} ${r.statusText}`);
  }
  const data = await r.json();
  const raw = data.deployed;
  const out: Record<number, number> = {};
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(raw)) {
      const slot = parseInt(k, 10);
      const val = raw[k];
      if (!Number.isNaN(slot) && typeof val === 'number' && Number.isInteger(val)) {
        out[slot] = val;
      }
    }
  }
  const graveyardRaw = data.graveyardSlots;
  const graveyardSlots = Array.isArray(graveyardRaw)
    ? graveyardRaw
        .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 2)
    : [];
  return { deployed: out, graveyardSlots };
}

export async function fetchFlyStats(address: string): Promise<FlyStatsData> {
  const enc = encodeURIComponent(normalizeAddress(address));
  const url = `${getApiBase()}/api/rewards/stats?address=${enc}`;
  let r: Response;
  try {
    r = await fetch(url);
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('[api] fetchFlyStats network error:', err, url);
    throw err;
  }
  if (!r.ok) {
    if (import.meta.env?.DEV) console.warn('[api] fetchFlyStats failed:', r.status, r.statusText, url);
    throw new Error(`Fly stats failed: ${r.status} ${r.statusText}`);
  }
  const data = await r.json();
  const rawStats = data.stats;
  const stats: { slotIndex: number; feedCount: number }[] = [];
  if (Array.isArray(rawStats)) {
    for (const item of rawStats) {
      if (item != null && typeof item === 'object' && typeof item.slotIndex === 'number' && typeof item.feedCount === 'number') {
        stats.push({ slotIndex: item.slotIndex, feedCount: item.feedCount });
      }
    }
  }
  const rp = data.rewardPerPointWei;
  const rewardPerPointWei = typeof rp === 'string' && rp.length > 0 ? rp : FALLBACK_WEI;
  return { stats, rewardPerPointWei };
}

export async function fetchGraveyard(address: string, page: number, pageSize = 3): Promise<GraveyardPageData> {
  const enc = encodeURIComponent(normalizeAddress(address));
  const p = Math.max(1, Math.floor(page || 1));
  const ps = Math.max(1, Math.min(20, Math.floor(pageSize || 3)));
  const url = `${getApiBase()}/api/deploy/graveyard?address=${enc}&page=${p}&pageSize=${ps}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Graveyard fetch failed: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const items: GraveyardFlyEntry[] = Array.isArray(data.items)
    ? data.items
        .filter((item: unknown) => item != null && typeof item === 'object')
        .map((item: unknown) => {
          const v = item as Record<string, unknown>;
          return {
            flyId: typeof v.flyId === 'string' ? v.flyId : 'unknown',
            slotIndex: typeof v.slotIndex === 'number' ? v.slotIndex : 0,
            feedCount: typeof v.feedCount === 'number' ? v.feedCount : 0,
            rewardWei: typeof v.rewardWei === 'string' ? v.rewardWei : '0',
            timeBirthed: typeof v.timeBirthed === 'string' ? v.timeBirthed : undefined,
            timeDeployed: typeof v.timeDeployed === 'string' ? v.timeDeployed : undefined,
            removedAt: typeof v.removedAt === 'string' || v.removedAt == null ? (v.removedAt as string | null) : null,
          };
        })
    : [];
  return {
    items,
    page: typeof data.page === 'number' ? data.page : p,
    pageSize: typeof data.pageSize === 'number' ? data.pageSize : ps,
    total: typeof data.total === 'number' ? data.total : items.length,
    totalPages: typeof data.totalPages === 'number' ? data.totalPages : 1,
  };
}
