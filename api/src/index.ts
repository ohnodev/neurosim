import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadConnectome } from './connectome.js';
import { createBrainSim } from './brain-sim.js';
import * as socketClient from './brain-socket-client.js';
import { getWorld, spawnFood, removeFood, getSources, type WorldSource } from './world.js';
import {
  getWorldPenPresets,
  WORLD_COMPASS_DEG,
  WORLD_COMPASS_STEP_DEG,
  WORLD_SIM_DT_SEC,
  type WorldCompassPosition,
} from './world-pen-presets.js';
import claimsRouter from './routes/claims.js';
import { getFlies, removeFlyAtSlot } from './services/flyStore.js';
import { getDeployments, addDeployment, clearForTesting, deactivateDeployment } from './services/deployStore.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  recordFeedingPoints,
  recordFoodDepleted,
  flushAccruedPointsToPending,
  getStatsForAddress,
  getDistributedHistory,
  REWARD_PER_POINT,
  getNeuroFlyStats,
} from './services/rewardStore.js';
import { flushRewards } from './services/rewardDistributor.js';

const PORT = Number(process.env.PORT) || 3001;
const connectome = loadConnectome();
const EPG_TILE_MAP_PATH = path.resolve(process.cwd(), '..', 'data', 'epg-tile-map.json');
const epgRootIdSet = (() => {
  try {
    const raw = fs.readFileSync(EPG_TILE_MAP_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { entries?: Array<{ root_id?: string }> };
    return new Set(
      (parsed.entries ?? [])
        .map((e) => String(e?.root_id ?? ''))
        .filter((id) => id.length > 0),
    );
  } catch {
    return new Set<string>();
  }
})();
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_SLOT_INDEX = 2;
const VIEWER_NEURON_LIMIT = Math.max(1, Number(process.env.NEUROSIM_VIEWER_NEURON_LIMIT ?? 10_000));
const CLIENT_ACTIVITY_LIMIT = Math.max(1, Number(process.env.NEUROSIM_CLIENT_ACTIVITY_LIMIT ?? 1_000));
const CLIENT_ACTIVITY_TTL_MS = Math.max(250, Number(process.env.NEUROSIM_CLIENT_ACTIVITY_TTL_MS ?? 4_000));
const CLIENT_ACTIVITY_FLOOR = Math.min(0.4, Math.max(0.01, Number(process.env.NEUROSIM_CLIENT_ACTIVITY_FLOOR ?? 0.08)));
const CLIENT_INPUT_ACTIVITY_DEFAULT = Math.min(0.9, Math.max(CLIENT_ACTIVITY_FLOOR, Number(process.env.NEUROSIM_CLIENT_INPUT_ACTIVITY ?? 0.55)));
const CLASSIFICATION_CSV_PATH = path.resolve(process.cwd(), '..', 'data', 'raw', 'classification.csv');
const OLFACTORY_AFFERENTS_PATH = path.resolve(process.cwd(), '..', 'data', 'olfactory-afferents.json');

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function loadPenABySide(): { left: string[]; right: string[] } {
  const left = new Set<string>();
  const right = new Set<string>();
  try {
    if (!fs.existsSync(CLASSIFICATION_CSV_PATH)) {
      return { left: [], right: [] };
    }
    const raw = fs.readFileSync(CLASSIFICATION_CSV_PATH, 'utf-8');
    const lines = raw.split(/\r?\n/);
    if (lines.length < 2) return { left: [], right: [] };
    const header = parseCsvLine(lines[0]!);
    const col = (name: string) => header.indexOf(name);
    const iRid = col('root_id');
    const iHb = col('hemibrain_type');
    const iSide = col('side');
    if (iRid < 0 || iHb < 0) return { left: [], right: [] };
    for (let li = 1; li < lines.length; li++) {
      const row = lines[li];
      if (!row) continue;
      const cols = parseCsvLine(row);
      const rid = (cols[iRid] ?? '').trim();
      if (!rid) continue;
      const htype = (cols[iHb] ?? '').trim();
      if (!htype.startsWith('PEN_a')) continue;
      const side = (iSide >= 0 ? (cols[iSide] ?? '') : '').trim().toLowerCase();
      if (side === 'left') left.add(rid);
      else if (side === 'right') right.add(rid);
    }
  } catch (e) {
    console.error('[neurosim-live] PEN_a load failed', e);
  }
  return { left: [...left].sort(), right: [...right].sort() };
}

const PEN_A_BY_SIDE = loadPenABySide();
const EPG_IDS_FOR_RUN_STEPS = [...epgRootIdSet].sort();

/** World 3-position PEN_a presets (11PM, 3PM, 8PM). */
const WORLD_PEN_PRESETS = getWorldPenPresets(PEN_A_BY_SIDE);

/** Per-sim next PEN_a preset for world steering. Index = sim index. */
const penPresetBySimIndex: WorldCompassPosition[] = [];

/** Per-sim smoothed bump angle (deg) for stable heading and compass. */
const smoothedBumpBySimIndex: (number | null)[] = [];

const BUMP_SMOOTH_ALPHA = 0.12; // strong smoothing so L1/L2/L6-only input gives stable direction

function smoothBumpDeg(prev: number | null, next: number, alpha: number): number {
  if (prev == null) return next;
  let d = ((next - prev + 540) % 360) - 180;
  let out = prev + d * alpha;
  out = ((out % 360) + 360) % 360;
  if (out > 180) out -= 360;
  return out;
}

const ODOR_DETECTION_RADIUS = 34;

function normalizeAngleDeg(deg: number): number {
  let a = deg;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

/** Pick the world compass position (11PM, 3PM, 8PM) closest to the given target angle in degrees. */
function chooseWorldPresetFromAngleDeg(angleToTargetDeg: number): WorldCompassPosition {
  let best: WorldCompassPosition = '11PM';
  let bestDiff = Infinity;
  for (const pos of ['11PM', '3PM', '8PM'] as const) {
    const d = Math.abs(normalizeAngleDeg(angleToTargetDeg - WORLD_COMPASS_DEG[pos]));
    if (d < bestDiff) {
      bestDiff = d;
      best = pos;
    }
  }
  return best;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function loadAfferentSensoryIdsByClass(): {
  mechanosensory: string[];
  thermosensory: string[];
  hygrosensory: string[];
  gustatory: string[];
} {
  const out = {
    mechanosensory: [] as string[],
    thermosensory: [] as string[],
    hygrosensory: [] as string[],
    gustatory: [] as string[],
  };
  try {
    const txt = fs.readFileSync(CLASSIFICATION_CSV_PATH, 'utf8');
    const lines = txt.split('\n').filter((l) => l.trim().length > 0);
    for (let i = 1; i < lines.length; i += 1) {
      const cols = parseCsvLine(lines[i] ?? '');
      if (cols.length < 4) continue;
      const rootId = cols[0] ?? '';
      const flow = cols[1] ?? '';
      const superClass = cols[2] ?? '';
      const neuronClass = cols[3] ?? '';
      if (!rootId || flow !== 'afferent' || superClass !== 'sensory') continue;
      if (neuronClass === 'mechanosensory') out.mechanosensory.push(rootId);
      if (neuronClass === 'thermosensory') out.thermosensory.push(rootId);
      if (neuronClass === 'hygrosensory') out.hygrosensory.push(rootId);
      if (neuronClass === 'gustatory') out.gustatory.push(rootId);
    }
  } catch {
    // fallback empty; request handler returns useful summary even without class IDs
  }
  return out;
}

const sensoryIdsByClass = loadAfferentSensoryIdsByClass();
function loadOlfactoryAfferentIds(): string[] {
  try {
    const raw = fs.readFileSync(OLFACTORY_AFFERENTS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      left?: string[];
      right?: string[];
      unknown?: string[];
    };
    return [...(parsed.left ?? []), ...(parsed.right ?? []), ...(parsed.unknown ?? [])]
      .map((v) => String(v))
      .filter((v) => v.length > 0);
  } catch {
    return [];
  }
}
const olfactoryAfferentIds = loadOlfactoryAfferentIds();
const olfactoryAfferentSet = new Set(olfactoryAfferentIds);

function computeViewerSubsetIndices(total: number): number[] {
  if (total <= VIEWER_NEURON_LIMIT) return Array.from({ length: total }, (_, i) => i);
  const ranked = connectome.neurons
    .map((n, i) => ({ i, h: fnv1a32(n.root_id) }))
    .sort((a, b) => (a.h - b.h) || (a.i - b.i))
    .slice(0, VIEWER_NEURON_LIMIT)
    .map((x) => x.i)
    .sort((a, b) => a - b);
  return ranked;
}

const viewerNeuronIndices = computeViewerSubsetIndices(connectome.neurons.length);
const viewerNeuronIndexSet = new Set<number>(viewerNeuronIndices);

/** Brain sim uses Unix socket only. Probe connects to brain-service; retry for PM2 start-order. */
const CUDA_ONLY = process.env.NEUROSIM_MODE === 'cuda' || process.env.USE_CUDA === '1';
const PROBE_RETRIES = 40;
const PROBE_DELAY_MS = 3000;

let backendInfo = { engine: 'python-brain', gpu: process.env.USE_CUDA === '1' };
let probeOk = false;
for (let i = 0; i < PROBE_RETRIES; i++) {
  try {
    await socketClient.ping();
    console.log('[backend] handshake: API ↔ brain-service OK');
    backendInfo = { engine: 'python-brain', gpu: process.env.USE_CUDA === '1' };
    probeOk = true;
    break;
  } catch (e) {
    if (i === PROBE_RETRIES - 1) {
      console.error('[backend] Brain service (Unix socket) unavailable after', PROBE_RETRIES, 'retries. Is python-brain running?', e);
      process.exit(1);
    }
    console.warn('[backend] Brain service not ready, retry', i + 1, '/', PROBE_RETRIES, 'in', PROBE_DELAY_MS, 'ms');
    await new Promise((r) => setTimeout(r, PROBE_DELAY_MS));
  }
}
if (probeOk && CUDA_ONLY && !backendInfo.gpu) {
  console.error('[backend] CUDA mode required but brain-service not using GPU. Refusing to start.');
  process.exit(1);
}
console.log(
  `[backend] brain=unix-socket engine=${backendInfo.engine} gpu=${backendInfo.gpu} mode=${CUDA_ONLY ? 'cuda-only' : 'auto'}`,
);

const GROUND_Z = 0.35;
const INITIAL_SPREAD = 4;
const SPAWN_JITTER_RADIUS = 1.25;

let foodIntervalId: ReturnType<typeof setInterval> | null = null;
let rewardFlushIntervalId: ReturnType<typeof setInterval> | null = null;

/** Simulation flies; starts empty, users deploy flies. */
const sims: Awaited<ReturnType<typeof createBrainSim>>[] = [];
/** address -> slotIndex -> simIndex */
const deployedFlies = new Map<string, Map<number, number>>();
/** Per-sim rolling activity memory so clients can receive rotating recent spikes/inputs. */
const simActivityTrail: Array<Map<string, { seenAt: number; value: number }>> = [];

function parseAndValidateAddress(raw: unknown): string | null {
  if (Array.isArray(raw) || typeof raw !== 'string') return null;
  const address = raw.toLowerCase();
  if (!ADDRESS_RE.test(address)) return null;
  return address;
}

function isValidSlotIndex(slotIndex: unknown): slotIndex is number {
  return (
    typeof slotIndex === 'number' &&
    Number.isFinite(slotIndex) &&
    Number.isInteger(slotIndex) &&
    slotIndex >= 0 &&
    slotIndex <= MAX_SLOT_INDEX
  );
}

function findDeploymentBySimIndex(simIndex: number): { address: string; slotIndex: number } | null {
  for (const [address, slotMap] of deployedFlies) {
    for (const [slotIndex, mappedIndex] of slotMap) {
      if (mappedIndex === simIndex) return { address, slotIndex };
    }
  }
  return null;
}

function removeSimAtIndex(simIndex: number): { address: string; slotIndex: number } | null {
  if (simIndex < 0 || simIndex >= sims.length) return null;
  const deployment = findDeploymentBySimIndex(simIndex);
  sims.splice(simIndex, 1);
  simActivityTrail.splice(simIndex, 1);
  penPresetBySimIndex.splice(simIndex, 1);
  smoothedBumpBySimIndex.splice(simIndex, 1);

  for (const [address, slotMap] of deployedFlies) {
    for (const [slotIndex, mappedIndex] of slotMap) {
      if (mappedIndex > simIndex) slotMap.set(slotIndex, mappedIndex - 1);
    }
  }
  if (deployment) {
    const slotMap = deployedFlies.get(deployment.address);
    slotMap?.delete(deployment.slotIndex);
    if (slotMap && slotMap.size === 0) deployedFlies.delete(deployment.address);
  }
  return deployment;
}

async function addFlyToSim(spawnKey?: string): Promise<number> {
  const baseAngle = (2 * Math.PI * sims.length) / Math.max(1, sims.length + 1);
  const h = fnv1a32(spawnKey ?? `sim-${sims.length}-${Date.now()}`);
  const jitterAngle = ((h & 1023) / 1023) * 2 * Math.PI;
  const jitterRadius = (((h >>> 10) & 1023) / 1023) * SPAWN_JITTER_RADIUS;
  const x = INITIAL_SPREAD * Math.cos(baseAngle) + jitterRadius * Math.cos(jitterAngle);
  const y = INITIAL_SPREAD * Math.sin(baseAngle) + jitterRadius * Math.sin(jitterAngle);
  const heading = (((h >>> 20) & 1023) / 1023) * 2 * Math.PI - Math.PI;
  const sim = await createBrainSim(connectome, () => getSources(), {
    x,
    y,
    z: GROUND_Z,
    heading,
    t: 0,
    hunger: 100,
    health: 100,
  });
  sims.push(sim);
  simActivityTrail.push(new Map());
  penPresetBySimIndex.push('11PM');
  smoothedBumpBySimIndex.push(null);
  return sims.length - 1;
}

async function restoreDeployFromStore(): Promise<void> {
  const records = getDeployments().filter(
    (r) => r.active !== false && isValidSlotIndex(r.slotIndex)
  );
  for (const { address, slotIndex } of records) {
    const simIndex = await addFlyToSim(`${address}:${slotIndex}`);
    let map = deployedFlies.get(address);
    if (!map) {
      map = new Map();
      deployedFlies.set(address, map);
    }
    map.set(slotIndex, simIndex);
  }
  if (records.length > 0) {
    console.log('[deploy] restored', records.length, 'deployments from store');
  }
}
try {
  await restoreDeployFromStore();
} catch (err) {
  console.error('[deploy] restore error:', err);
}
let simRunning = false;
let simIntervalId: ReturnType<typeof setInterval> | null = null;
/** World loop: 4 batches/sec (250ms), 8 interpolated frames per batch → ~32 FPS. One round-trip per batch. */
const SIM_FPS = 30;
const BATCH_MS = 250;
const FRAMES_PER_BATCH = 8;
/** One run_steps call per batch: advance 0.25s sim time per batch. */
const WORLD_STEPS_PER_BATCH = Math.max(1, Math.round(0.25 / WORLD_SIM_DT_SEC));
const BRAIN_INIT_GRACE_MS = Number(process.env.NEUROSIM_BRAIN_INIT_GRACE_MS ?? 10_000);
let connectionStep = 0;
let nextBatchDueAt = 0;
let simTickInFlight = false;
let droppedSimTicks = 0;
let simReadyAtMs = 0;
let graceSkippedTicks = 0;
let graceSkipLogged = false;

const wsClients = new Set<import('ws').WebSocket>();
/** Per-client: which fly's activity to send (sim index). Default 0. */
const clientViewFlyIndex = new Map<import('ws').WebSocket, number>();
/** Per-client cursor for rotating activity windows. */
const clientActivityCursor = new Map<import('ws').WebSocket, number>();

function broadcast(data: unknown): void {
  const payload = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

/** Build per-client payload. Activity and sources sent once per batch (client only uses last). */
function buildClientPayload(
  frames: {
    t: number;
    flies: ReturnType<typeof sims[0]['getState']>['fly'][];
    activities: (Record<string, number> | undefined)[];
    inputActivities: (Record<string, number> | undefined)[];
    motorReadouts: ({
      left: number;
      right: number;
      fwd: number;
      leftCount: number;
      rightCount: number;
      fwdCount: number;
      leftMagnitude: number;
      rightMagnitude: number;
      fwdMagnitude: number;
    } | undefined)[];
    bumpAngleDegs: (number | null)[];
    epgBinsPerSim: (number[] | null)[];
  }[],
): void {
  const nowMs = Date.now();
  const sources = getSources();
  const clientFrames = frames.map((f) => ({
    t: f.t,
    flies: f.flies,
    bumpAngleDegs: f.bumpAngleDegs,
    epgBinsPerSim: f.epgBinsPerSim,
  }));
  const lastFrame = frames[frames.length - 1];
  for (const ws of wsClients) {
    if (ws.readyState !== 1) continue;
    const viewIndex = Math.max(0, Math.min(sims.length - 1, clientViewFlyIndex.get(ws) ?? 0));
    const activity = buildRotatingActivityWindow(
      ws,
      viewIndex,
      lastFrame ? (lastFrame.activities[viewIndex] ?? {}) : {},
      lastFrame ? (lastFrame.inputActivities[viewIndex] ?? {}) : {},
      nowMs,
    );
    const motor = lastFrame ? (lastFrame.motorReadouts[viewIndex] ?? undefined) : undefined;
    try {
      ws.send(JSON.stringify({ frames: clientFrames, activity, motor, sources, simRunning: true }));
    } catch (err) {
      console.error('[ws] send error', err);
    }
  }
}

function buildRotatingActivityWindow(
  ws: import('ws').WebSocket,
  simIndex: number,
  latestActivity: Record<string, number>,
  latestInputActivity: Record<string, number>,
  nowMs: number,
): Record<string, number> {
  const trail = simActivityTrail[simIndex] ?? null;
  if (!trail) return latestActivity;

  for (const [id, entry] of trail.entries()) {
    if (nowMs - entry.seenAt > CLIENT_ACTIVITY_TTL_MS) trail.delete(id);
  }
  for (const [id, value] of Object.entries(latestActivity)) {
    if (value > 0) {
      trail.set(id, { seenAt: nowMs, value: 1 });
    }
  }
  for (const [id, value] of Object.entries(latestInputActivity)) {
    if (value > 0) {
      const prev = trail.get(id);
      trail.set(id, {
        seenAt: nowMs,
        value: Math.max(prev?.value ?? 0, Math.max(CLIENT_ACTIVITY_FLOOR, Math.min(0.95, value || CLIENT_INPUT_ACTIVITY_DEFAULT))),
      });
    }
  }

  const ids = Array.from(
    new Set<string>([
      ...trail.keys(),
      ...Object.keys(latestActivity),
      ...Object.keys(latestInputActivity),
    ]),
  );
  if (ids.length === 0) return latestActivity;

  const activeNow = Array.from(
    new Set<string>([
      ...Object.keys(latestActivity).filter((id) => (latestActivity[id] ?? 0) > 0),
      ...Object.keys(latestInputActivity).filter((id) => (latestInputActivity[id] ?? 0) > 0),
    ]),
  );
  const activeSet = new Set(activeNow);
  const rotatingPool = ids.filter((id) => !activeSet.has(id));

  const limit = Math.min(CLIENT_ACTIVITY_LIMIT, ids.length);
  const activeSelected = activeNow.slice(0, limit);
  const remaining = Math.max(0, limit - activeSelected.length);
  const hasPoolOverflow = rotatingPool.length > remaining;
  const start = hasPoolOverflow ? ((clientActivityCursor.get(ws) ?? 0) % rotatingPool.length) : 0;
  const selected: string[] = [...activeSelected];
  for (let i = 0; i < remaining; i++) {
    if (rotatingPool.length === 0) break;
    selected.push(rotatingPool[(start + i) % rotatingPool.length]!);
  }

  const out: Record<string, number> = {};
  for (const id of selected) {
    const direct = latestActivity[id] ?? 0;
    if (direct > 0) {
      out[id] = 1;
      continue;
    }
    const directInput = latestInputActivity[id] ?? 0;
    if (directInput > 0) {
      out[id] = Math.max(CLIENT_ACTIVITY_FLOOR, Math.min(0.95, directInput));
      continue;
    }
    const entry = trail.get(id);
    if (!entry) continue;
    const age = Math.max(0, nowMs - entry.seenAt);
    const normalized = 1 - age / CLIENT_ACTIVITY_TTL_MS;
    const decayed = entry.value * normalized;
    if (decayed > 0) out[id] = Math.max(CLIENT_ACTIVITY_FLOOR, decayed);
  }
  if (hasPoolOverflow && rotatingPool.length > 0) {
    clientActivityCursor.set(ws, (start + remaining) % rotatingPool.length);
  }
  return out;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpHeading(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function startSim(): void {
  if (simRunning) return;
  simRunning = true;
  simReadyAtMs = Date.now() + Math.max(0, BRAIN_INIT_GRACE_MS);
  connectionStep = 0;
  nextBatchDueAt = performance.now() + BATCH_MS;
  simTickInFlight = false;
  droppedSimTicks = 0;
  graceSkippedTicks = 0;
  graceSkipLogged = false;
  spawnFood();
  foodIntervalId = setInterval(() => {
    const f = spawnFood();
    if (f) {
      console.log('[world] spawned food', f.id, 'at', f.x.toFixed(1), f.y.toFixed(1));
      broadcast({ simRunning, sources: getSources() });
    }
  }, 5_000);
  simIntervalId = setInterval(async () => {
    if (Date.now() < simReadyAtMs) {
      graceSkippedTicks += 1;
      if (!graceSkipLogged) {
        const remainingMs = Math.max(0, simReadyAtMs - Date.now());
        console.log('[sim] waiting for brain init grace period', { remainingMs, graceSkippedTicks });
        graceSkipLogged = true;
      }
      return;
    }
    if (simTickInFlight) {
      droppedSimTicks += 1;
      return;
    }
    simTickInFlight = true;
    try {
      const loopStart = performance.now();
      const schedulerLagMs = Math.max(0, Math.round(loopStart - nextBatchDueAt));
      nextBatchDueAt = loopStart + BATCH_MS;
      const nSims = sims.length;
      let stepMs = 0;
      let jsMs = 0;
      let maxStepMs = 0;
      let maxJsMs = 0;
      let socketRoundtripMs = 0;
      let socketWaitMs = 0;
      let batchCalls = 0;
      let batchSize = 0;
      const dtFrame = 1 / SIM_FPS;
      const frames: {
        t: number;
        flies: ReturnType<typeof sims[0]['getState']>['fly'][];
        activities: (Record<string, number> | undefined)[];
        inputActivities: (Record<string, number> | undefined)[];
        motorReadouts: ({
          left: number;
          right: number;
          fwd: number;
          leftCount: number;
          rightCount: number;
          fwdCount: number;
          leftMagnitude: number;
          rightMagnitude: number;
          fwdMagnitude: number;
        } | undefined)[];
        bumpAngleDegs: (number | null)[];
        epgBinsPerSim: (number[] | null)[];
      }[] = [];

      const transitions: Array<{
        fromFly: ReturnType<typeof sims[0]['getState']>['fly'];
        toFly: ReturnType<typeof sims[0]['getState']>['fly'];
        fromT: number;
        toT: number;
        activity?: Record<string, number>;
        inputActivity?: Record<string, number>;
        motorLeft?: number;
        motorRight?: number;
        motorFwd?: number;
        motorLeftCount?: number;
        motorRightCount?: number;
        motorFwdCount?: number;
        motorLeftMagnitude?: number;
        motorRightMagnitude?: number;
        motorFwdMagnitude?: number;
        bumpAngleDeg?: number | null;
        epgBins?: number[] | null;
      }> = [];

      const beforeStates = sims.map((s) => s.getState());
      const viewedSimIndexes = new Set<number>();
      if (wsClients.size > 0) {
        for (const ws of wsClients) {
          const idx = Math.max(0, Math.min(sims.length - 1, clientViewFlyIndex.get(ws) ?? 0));
          viewedSimIndexes.add(idx);
        }
      }
      const currentSources = getSources();
      const states = await Promise.all(
        sims.map(async (s, idx) => {
          const preset = penPresetBySimIndex[idx] ?? '11PM';
          const ratesById = WORLD_PEN_PRESETS[preset];
          const state = await (s as { stepBatch?: (dt: number, n: number, src: WorldSource[], rates?: Record<string, number>) => Promise<ReturnType<typeof sims[0]['getState']>> }).stepBatch?.(
            WORLD_SIM_DT_SEC,
            WORLD_STEPS_PER_BATCH,
            currentSources,
            ratesById,
          );
          return state ?? s.getState();
        }),
      );
      const activityNowMs = Date.now();
      const deadSimIndexes: number[] = [];
      for (let j = 0; j < nSims; j++) {
        const before = beforeStates[j];
        const state = states[j];
        const gt = (sims[j] as {
          getTiming?: () => {
            rustMs: number;
            jsMs: number;
            socketTotalMs?: number;
            socketResponseWaitMs?: number;
            socketBatchSize?: number;
          };
        }).getTiming?.();
        if (gt) {
          stepMs += gt.rustMs;
          jsMs += gt.jsMs;
          const thisBatchSize = gt.socketBatchSize ?? 1;
          if (thisBatchSize > 1) {
            if (j === 0) {
              socketRoundtripMs += gt.socketTotalMs ?? 0;
              socketWaitMs += gt.socketResponseWaitMs ?? 0;
              batchCalls += 1;
              batchSize = thisBatchSize;
            }
          } else {
            socketRoundtripMs += gt.socketTotalMs ?? 0;
            socketWaitMs += gt.socketResponseWaitMs ?? 0;
            batchCalls += 1;
            if (batchSize < 1) batchSize = 1;
          }
          if (gt.rustMs > maxStepMs) maxStepMs = gt.rustMs;
          if (gt.jsMs > maxJsMs) maxJsMs = gt.jsMs;
        }
        if (state.eatenFoodId) {
          removeFood(state.eatenFoodId);
          const deployment = findDeploymentBySimIndex(j);
          if (deployment) {
            recordFoodDepleted(deployment.address, deployment.slotIndex);
          }
          console.log('[world] fly', j, 'ate food', state.eatenFoodId);
        }
        if ((state.feedingSugarTaken ?? 0) > 0) {
          const deployment = findDeploymentBySimIndex(j);
          if (deployment) {
            recordFeedingPoints(deployment.address, deployment.slotIndex, state.feedingSugarTaken ?? 0);
          }
        }
        if (state.activity && simActivityTrail[j]) {
          const trail = simActivityTrail[j]!;
          for (const [id, value] of Object.entries(state.activity)) {
            if (value > 0) trail.set(id, { seenAt: activityNowMs, value: 1 });
          }
        }
        if (state.inputActivity && simActivityTrail[j]) {
          const trail = simActivityTrail[j]!;
          for (const [id, value] of Object.entries(state.inputActivity)) {
            if (value > 0) {
              const prev = trail.get(id);
              trail.set(id, {
                seenAt: activityNowMs,
                value: Math.max(prev?.value ?? 0, Math.max(CLIENT_ACTIVITY_FLOOR, Math.min(0.95, value || CLIENT_INPUT_ACTIVITY_DEFAULT))),
              });
            }
          }
        }
        if (state.fly.dead || (state.fly.health ?? 100) <= 0) {
          deadSimIndexes.push(j);
        }

        // Position 1 only: 11PM (L1:50, L2:50, L6:50). Smooth bump so heading and compass are stable.
        let toFly = state.fly;
        const rawBump = state.bumpAngleDeg ?? null;
        const smoothed =
          rawBump != null
            ? smoothBumpDeg(smoothedBumpBySimIndex[j] ?? null, rawBump, BUMP_SMOOTH_ALPHA)
            : null;
        if (smoothed != null) smoothedBumpBySimIndex[j] = smoothed;

        if (smoothed != null) {
          toFly = { ...toFly, heading: (smoothed * Math.PI) / 180 };
        }

        transitions.push({
          fromFly: before.fly,
          toFly,
          fromT: before.t,
          toT: state.t,
          activity: state.activity,
          inputActivity: state.inputActivity,
          motorLeft: state.motorLeft,
          motorRight: state.motorRight,
          motorFwd: state.motorFwd,
          motorLeftCount: state.motorLeftCount,
          motorRightCount: state.motorRightCount,
          motorFwdCount: state.motorFwdCount,
          motorLeftMagnitude: state.motorLeftMagnitude,
          motorRightMagnitude: state.motorRightMagnitude,
          motorFwdMagnitude: state.motorFwdMagnitude,
          bumpAngleDeg: smoothed ?? rawBump ?? undefined,
          epgBins: state.epgBins ?? undefined,
        });
      }

      if (deadSimIndexes.length > 0) {
        const uniqueDead = [...new Set(deadSimIndexes)].sort((a, b) => b - a);
        for (const simIndex of uniqueDead) {
          const removed = removeSimAtIndex(simIndex);
          if (!removed) continue;
          const graveyarded = removeFlyAtSlot(removed.address, removed.slotIndex);
          deactivateDeployment(removed.address, removed.slotIndex);
          console.log(
            '[graveyard:auto]',
            removed.address.slice(0, 10) + '…',
            'slot',
            removed.slotIndex,
            'sim',
            simIndex,
            graveyarded ? `fly ${graveyarded.id}` : 'fly <already removed>'
          );
        }
      }

      for (let i = 1; i <= FRAMES_PER_BATCH; i++) {
        const alpha = i / FRAMES_PER_BATCH;
        const flies: ReturnType<typeof sims[0]['getState']>['fly'][] = transitions.map((tr) => ({
          ...tr.toFly,
          x: lerp(tr.fromFly.x, tr.toFly.x, alpha),
          y: lerp(tr.fromFly.y, tr.toFly.y, alpha),
          z: lerp(tr.fromFly.z, tr.toFly.z, alpha),
          heading: lerpHeading(tr.fromFly.heading, tr.toFly.heading, alpha),
          t: lerp(tr.fromFly.t, tr.toFly.t, alpha),
          hunger: lerp(tr.fromFly.hunger, tr.toFly.hunger, alpha),
          health: lerp(tr.fromFly.health ?? 100, tr.toFly.health ?? 100, alpha),
        }));
        const activities = transitions.map((tr) => (i === FRAMES_PER_BATCH ? tr.activity : undefined));
        const inputActivities = transitions.map((tr) => (i === FRAMES_PER_BATCH ? tr.inputActivity : undefined));
        const motorReadouts = transitions.map((tr) =>
          i === FRAMES_PER_BATCH
            ? {
                left: tr.motorLeft ?? 0,
                right: tr.motorRight ?? 0,
                fwd: tr.motorFwd ?? 0,
                leftCount: tr.motorLeftCount ?? 0,
                rightCount: tr.motorRightCount ?? 0,
                fwdCount: tr.motorFwdCount ?? 0,
                leftMagnitude: tr.motorLeftMagnitude ?? 0,
                rightMagnitude: tr.motorRightMagnitude ?? 0,
                fwdMagnitude: tr.motorFwdMagnitude ?? 0,
              }
            : undefined,
        );
        const t = transitions.length ? lerp(transitions[0].fromT, transitions[0].toT, alpha) : 0;
        const bumpAngleDegs = transitions.map((tr) => tr.bumpAngleDeg ?? null);
        const epgBinsPerSim = transitions.map((tr) => tr.epgBins ?? null);
        frames.push({ t, flies, activities, inputActivities, motorReadouts, bumpAngleDegs, epgBinsPerSim });
      }
      const beforePayload = performance.now();
      buildClientPayload(frames);
      const buildPayloadMs = Math.round(performance.now() - beforePayload);
      connectionStep += 1;
      if (connectionStep % 15 === 0) {
        const last = frames[frames.length - 1];
        const first = last?.flies[0];
        const loopMs = Math.round(performance.now() - loopStart);
        const rustCalls = sims.length;
        const avgStep = rustCalls ? Math.round(stepMs / rustCalls) : 0;
        const avgJs = rustCalls ? Math.round(jsMs / rustCalls) : 0;
        const avgSocketRoundtrip = batchCalls ? Math.round(socketRoundtripMs / batchCalls) : 0;
        const avgSocketWait = batchCalls ? Math.round(socketWaitMs / batchCalls) : 0;
        const timingStr =
          ` stepMs=${stepMs} jsMs=${jsMs} avgStep=${avgStep} avgJs=${avgJs} maxStep=${maxStepMs} maxJs=${maxJsMs} socketRoundtripMs=${socketRoundtripMs} socketWaitMs=${socketWaitMs} avgSocketRoundtrip=${avgSocketRoundtrip} avgSocketWait=${avgSocketWait} batchCalls=${batchCalls} batchSize=${batchSize} simCalls=${rustCalls} synthFrames=${FRAMES_PER_BATCH} payloadMs=${buildPayloadMs} schedulerLagMs=${schedulerLagMs} droppedTicks=${droppedSimTicks}`;
        console.log('[sim] t=', last?.t.toFixed(1), 'flies=', last?.flies.length ?? 0, first ? `first=(${first.x?.toFixed(2)},${first.y?.toFixed(2)})` : '', 'clients=', wsClients.size, 'loopMs=', loopMs, timingStr);
      }
    } finally {
      simTickInFlight = false;
    }
  }, BATCH_MS);
  rewardFlushIntervalId = setInterval(() => {
    flushAccruedPointsToPending();
    void flushRewards();
  }, 60_000);
  console.log('[sim] started');
}

function stopSim(): void {
  if (foodIntervalId) {
    clearInterval(foodIntervalId);
    foodIntervalId = null;
  }
  if (rewardFlushIntervalId) {
    clearInterval(rewardFlushIntervalId);
    rewardFlushIntervalId = null;
  }
  if (!simRunning) return;
  simRunning = false;
  if (simIntervalId) {
    clearInterval(simIntervalId);
    simIntervalId = null;
  }
  console.log('[sim] stopped');
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/connectome', (_, res) => {
  res.json({
    neurons: connectome.neurons.length,
    connections: connectome.connections.length,
    meta: connectome.meta,
  });
});

app.get('/api/health', (_, res) =>
  res.json({
    ok: true,
    backend: {
      engine: backendInfo.engine,
      gpu: backendInfo.gpu,
      rust: backendInfo.engine === 'rust',
    },
  }));

/** Debug position buffer for smoothness testing; only when DEBUG_POSITIONS=1 */
const DEBUG_POSITIONS_ENABLED = process.env.DEBUG_POSITIONS === '1';
const POSITION_BUFFER_MAX = 1000;
const positionSamples: Array<{ tDisplay: number; delta: number; alpha: number; x: number; y: number; z: number; buf: number; ts: number }> = [];

if (DEBUG_POSITIONS_ENABLED) {
  app.post('/api/debug/positions', (req, res) => {
    try {
      const samples = req.body?.samples;
      if (!Array.isArray(samples)) {
        res.status(400).json({ error: 'Expected { samples: [...] }' });
        return;
      }
      const ts = Date.now();
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      for (const s of samples) {
        if (typeof s?.tDisplay !== 'number' || !Number.isFinite(s.tDisplay) ||
            typeof s?.x !== 'number' || !Number.isFinite(s.x) ||
            typeof s?.y !== 'number' || !Number.isFinite(s.y)) continue;
        positionSamples.push({
          tDisplay: s.tDisplay,
          delta: num(s.delta),
          alpha: num(s.alpha),
          x: s.x,
          y: s.y,
          z: num(s.z),
          buf: num(s.buf),
          ts,
        });
        if (positionSamples.length > POSITION_BUFFER_MAX) positionSamples.shift();
      }
      res.json({ ok: true, count: positionSamples.length });
    } catch (err) {
      console.error('[debug] positions error:', err);
      res.status(500).json({ error: 'Failed to record positions' });
    }
  });

  app.get('/api/debug/positions', (req, res) => {
    const clear = req.query.clear === '1';
    const samples = [...positionSamples];
    if (clear) positionSamples.length = 0;
    res.json({ samples });
  });
}

app.get('/api/neurons', (req, res) => {
  const full = req.query.full === '1';
  const epgOnly = req.query.epgOnly === '1';
  const neurons = connectome.neurons
    .filter((n, i) => (!epgOnly || epgRootIdSet.has(n.root_id)) && (full || viewerNeuronIndexSet.has(i)))
    .map((n) => ({
    root_id: n.root_id,
    role: n.role,
    side: n.side,
    cell_type: n.cell_type,
    ...(n.x != null && { x: n.x }),
    ...(n.y != null && { y: n.y }),
    ...(n.z != null && { z: n.z }),
  }));
  res.json({
    neurons,
    full,
    epgOnly,
    viewerNeuronLimit: VIEWER_NEURON_LIMIT,
    viewerNeuronCount: viewerNeuronIndices.length,
    totalNeuronCount: connectome.neurons.length,
  });
});

/** Return PEN_a neuron list for live per-neuron controls (id + label L1..L10, R1..R10). */
app.get('/api/neurosim-live/pen-a-neurons', (_req, res) => {
  const left = PEN_A_BY_SIDE.left.map((id, i) => ({ id, label: `L${i + 1}` }));
  const right = PEN_A_BY_SIDE.right.map((id, i) => ({ id, label: `R${i + 1}` }));
  res.json({ left, right });
});

/** Brain-service runs one continuous sim from startup; we only read ticks + apply Hz. */
app.get('/api/neurosim-live/status', async (_req, res) => {
  try {
    const s = await socketClient.liveStatus();
    res.json({
      ok: true,
      latestTick: s.latest_tick,
      penALeftHz: s.left_hz,
      penARightHz: s.right_hz,
      dtSec: s.dt_sec,
    });
  } catch (e) {
    console.error('[neurosim-live/status]', e);
    res.status(500).json({ error: (e as Error).message ?? String(e) });
  }
});

app.get('/api/neurosim-live/ticks', async (req, res) => {
  try {
    const after = Math.max(0, Math.floor(Number(req.query.after ?? 0)));
    const max = Math.max(1, Math.min(8000, Math.floor(Number(req.query.max ?? 2000))));
    const out = await socketClient.liveReadTicks(after, max);
    res.json({
      ticks: out.ticks ?? [],
      latestTick: out.latest_tick,
      dtSec: out.dt_sec,
    });
  } catch (e) {
    console.error('[neurosim-live/ticks]', e);
    res.status(500).json({ error: (e as Error).message ?? String(e) });
  }
});

app.post('/api/neurosim-live/apply', async (req, res) => {
  try {
    const left = Math.max(0, Math.min(500, Number(req.body?.penALeftHz ?? 0)));
    const right = Math.max(0, Math.min(500, Number(req.body?.penARightHz ?? 0)));
    const ratesById = req.body?.ratesById as Record<string, number> | undefined;
    const merged: Record<string, number> = {};
    for (const id of PEN_A_BY_SIDE.left) {
      const v = ratesById?.[id];
      merged[id] = Number.isFinite(Number(v)) ? Math.min(500, Math.max(0, Number(v))) : left;
    }
    for (const id of PEN_A_BY_SIDE.right) {
      const v = ratesById?.[id];
      merged[id] = Number.isFinite(Number(v)) ? Math.min(500, Math.max(0, Number(v))) : right;
    }
    await socketClient.liveSetPenA(left, right, merged);
    res.json({ ok: true, penALeftHz: left, penARightHz: right });
  } catch (e) {
    console.error('[neurosim-live/apply]', e);
    res.status(500).json({ error: (e as Error).message ?? String(e) });
  }
});

app.post('/api/neurosim-baseline/export', async (req, res) => {
  try {
    const startedAt = Date.now();
    const ticks = Math.max(1, Math.min(20_000, Number(req.body?.ticks ?? 1000)));
    const rawDt = req.body?.dt_sec ?? req.body?.dtSec ?? 0.001;
    const requestedDtSec = Number(rawDt);
    const defaultDtSec = 0.001;
    const validRequestedDt = Number.isFinite(requestedDtSec) ? requestedDtSec : defaultDtSec;
    // Fly-Brain exact mode is default for this export path.
    const flyBrainExact = req.body?.flyBrainExact !== false;
    const dtSec = flyBrainExact
      ? 0.0001
      : Math.max(0.0001, Math.min(0.1, validRequestedDt));
    const olfactoryBaselineHz = Math.max(0, Number(req.body?.olfactoryBaselineHz ?? 20));
    const mechanoHz = Math.max(0, Number(req.body?.mechanoHz ?? 0));
    const thermoHz = Math.max(0, Number(req.body?.thermoHz ?? 0.5));
    const hygroHz = Math.max(0, Number(req.body?.hygroHz ?? 0.5));
    const gustatoryHz = Math.max(0, Number(req.body?.gustatoryHz ?? 0));
    const batchSize = Math.max(1, Math.min(500, Number(req.body?.batchSize ?? 100)));
    const rng = createSeededRandom(0x5f43e21d);
    const sampleForced = (ids: string[], hz: number): string[] => {
      if (hz <= 0 || ids.length === 0) return [];
      const p = Math.min(1, hz * dtSec);
      const out: string[] = [];
      for (const id of ids) {
        if (rng() < p) out.push(id);
      }
      return out;
    };

    const forcedSpikeEvents = {
      mechanosensory: 0,
      thermosensory: 0,
      hygrosensory: 0,
      gustatory: 0,
    };

    const { simId } = await socketClient.createSim();
    const afferentPoolSet = new Set<string>([
      ...olfactoryAfferentIds,
      ...sensoryIdsByClass.mechanosensory,
      ...sensoryIdsByClass.thermosensory,
      ...sensoryIdsByClass.hygrosensory,
      ...sensoryIdsByClass.gustatory,
    ]);
    const forcedUniqueByClass = {
      mechanosensory: new Set<string>(),
      thermosensory: new Set<string>(),
      hygrosensory: new Set<string>(),
      gustatory: new Set<string>(),
    };
    const forcedUniqueAfferent = new Set<string>();
    console.log(
      `[neurosim-baseline] afferent pools olfactory=${olfactoryAfferentIds.length} mechanosensory=${sensoryIdsByClass.mechanosensory.length} thermosensory=${sensoryIdsByClass.thermosensory.length} hygrosensory=${sensoryIdsByClass.hygrosensory.length} gustatory=${sensoryIdsByClass.gustatory.length} totalUnique=${afferentPoolSet.size}`,
    );
    console.log(
      `[neurosim-baseline] start simId=${simId} ticks=${ticks} dt_sec=${dtSec} batchSize=${batchSize} olfHz=${olfactoryBaselineHz} flyBrainExact=${flyBrainExact}`,
    );
    if (flyBrainExact && Number.isFinite(requestedDtSec) && Math.abs(requestedDtSec - 0.0001) > 1e-12) {
      console.log(
        `[neurosim-baseline] forcing fly-brain dt from requested=${requestedDtSec} to dt_sec=0.0001`,
      );
    }
    let nextTick = 1;
    const replayTicks: Array<socketClient.ReplayTick> = [];
    let lastProgressPct = -1;
    while (nextTick <= ticks) {
      const batchStartedAt = Date.now();
      const take = Math.min(batchSize, ticks - nextTick + 1);
      const forcedByStep: string[][] = [];
      for (let i = 0; i < take; i += 1) {
        const forcedMech = sampleForced(sensoryIdsByClass.mechanosensory, mechanoHz);
        const forcedThermo = sampleForced(sensoryIdsByClass.thermosensory, thermoHz);
        const forcedHygro = sampleForced(sensoryIdsByClass.hygrosensory, hygroHz);
        const forcedGust = sampleForced(sensoryIdsByClass.gustatory, gustatoryHz);
        for (const id of forcedMech) {
          forcedUniqueByClass.mechanosensory.add(id);
          forcedUniqueAfferent.add(id);
        }
        for (const id of forcedThermo) {
          forcedUniqueByClass.thermosensory.add(id);
          forcedUniqueAfferent.add(id);
        }
        for (const id of forcedHygro) {
          forcedUniqueByClass.hygrosensory.add(id);
          forcedUniqueAfferent.add(id);
        }
        for (const id of forcedGust) {
          forcedUniqueByClass.gustatory.add(id);
          forcedUniqueAfferent.add(id);
        }
        forcedSpikeEvents.mechanosensory += forcedMech.length;
        forcedSpikeEvents.thermosensory += forcedThermo.length;
        forcedSpikeEvents.hygrosensory += forcedHygro.length;
        forcedSpikeEvents.gustatory += forcedGust.length;
        forcedByStep.push([...forcedMech, ...forcedThermo, ...forcedHygro, ...forcedGust]);
      }
      const batch = await socketClient.runReplayBatch({
        simId,
        dt: dtSec,
        startTick: nextTick,
        count: take,
        olfactoryBaselineRateHz: olfactoryBaselineHz,
        forcedSpikesByStep: forcedByStep,
      });
      replayTicks.push(...batch);
      nextTick += take;
      const completed = replayTicks.length;
      const pct = Math.floor((completed / ticks) * 100);
      const elapsedMs = Date.now() - startedAt;
      const batchMs = Date.now() - batchStartedAt;
      if (pct >= lastProgressPct + 1 || completed === ticks) {
        lastProgressPct = pct;
        const rate = elapsedMs > 0 ? completed / (elapsedMs / 1000) : 0;
        const etaSec = rate > 0 ? Math.max(0, (ticks - completed) / rate) : 0;
        console.log(
          `[neurosim-baseline] progress ${completed}/${ticks} (${pct}%) batchMs=${batchMs} elapsedMs=${elapsedMs} etaSec=${etaSec.toFixed(1)}`,
        );
      }
    }

    const neurons = connectome.neurons
      .filter((n) => epgRootIdSet.has(n.root_id))
      .map((n) => ({
        root_id: n.root_id,
        x: typeof n.x === 'number' ? n.x : 0,
        y: typeof n.y === 'number' ? n.y : 0,
        z: typeof n.z === 'number' ? n.z : 0,
        processed_label: n.cell_type,
        is_ring: true,
        is_epg: true,
        side: n.side ?? 'unknown',
        hemibrain_type: n.cell_type ?? '',
        flow: n.role,
        cell_type: n.cell_type,
      }));
    const epgIds = new Set(neurons.map((n) => n.root_id));
    const overallUnique = new Set<string>();
    let overallSpikeEvents = 0;
    const epgUnique = new Set<string>();
    let epgSpikeEvents = 0;
    const observedAfferentUnique = new Set<string>();
    let observedAfferentSpikeEvents = 0;
    const observedOlfactoryUnique = new Set<string>();
    let observedOlfactorySpikeEvents = 0;
    for (const t of replayTicks) {
      overallSpikeEvents += t.totalSpikeEventsStep ?? t.spikes.length;
      const afferentFromSpikes = t.spikes.filter((id) => afferentPoolSet.has(id));
      const olfactoryFromSpikes = t.spikes.filter((id) => olfactoryAfferentSet.has(id));
      observedAfferentSpikeEvents += t.afferentSpikeEventsStep ?? afferentFromSpikes.length;
      observedOlfactorySpikeEvents += t.olfactorySpikeEventsStep ?? olfactoryFromSpikes.length;
      for (const id of t.afferentSpikeIdsStep ?? afferentFromSpikes) observedAfferentUnique.add(id);
      for (const id of t.olfactorySpikeIdsStep ?? olfactoryFromSpikes) observedOlfactoryUnique.add(id);
      for (const id of t.spikes) {
        overallUnique.add(id);
        if (epgIds.has(id)) {
          epgUnique.add(id);
          epgSpikeEvents += 1;
        }
      }
    }

    const replay = {
      meta: {
        generated_at: new Date().toISOString(),
        source_csv: 'api:/api/neurosim-baseline/export',
        ticks: replayTicks.length,
        unique_fired_neurons: overallUnique.size,
        ring_neuron_total: neurons.length,
        ring_neuron_unique_fired: epgUnique.size,
        dt_sec: dtSec,
        epg_neuron_total: neurons.length,
        epg_neuron_unique_fired: epgUnique.size,
        scenario: 'neurosim_natural_20hz_1000ticks',
        baseline: {
          flyBrainExact,
          olfactoryBaselineHz,
          mechanoHz,
          thermoHz,
          hygroHz,
          gustatoryHz,
          batchSize,
          forcedSpikeEvents,
          overallSpikeEvents,
          epgSpikeEvents,
        },
      },
      neurons,
      ticks: replayTicks,
    };
    const outPath = path.resolve(process.cwd(), '..', 'world', 'public', 'neurosim_natural_1000tick_replay.json');
    fs.writeFileSync(outPath, `${JSON.stringify(replay)}\n`, 'utf8');
    const summaryPath = path.resolve(process.cwd(), '..', 'logs', 'neurosim_baseline_summary.txt');
    const summary = [
      'NeuroSim baseline export summary',
      `ticks: ${replayTicks.length}`,
      `dt_sec: ${dtSec}`,
      `flyBrainExact: ${flyBrainExact}`,
      `olfactoryBaselineHz: ${olfactoryBaselineHz}`,
      `mechanoHz: ${mechanoHz}`,
      `thermoHz: ${thermoHz}`,
      `hygroHz: ${hygroHz}`,
      `gustatoryHz: ${gustatoryHz}`,
      `overallSpikeEvents: ${overallSpikeEvents}`,
      `overallUniqueFiredNeurons: ${overallUnique.size}`,
      `epgSpikeEvents: ${epgSpikeEvents}`,
      `epgUniqueFiredNeurons: ${epgUnique.size}`,
      `forcedSpikeEvents: ${JSON.stringify(forcedSpikeEvents)}`,
      `forcedUniqueAfferentIds: ${forcedUniqueAfferent.size}`,
      `forcedUniqueByClass: ${JSON.stringify({
        mechanosensory: forcedUniqueByClass.mechanosensory.size,
        thermosensory: forcedUniqueByClass.thermosensory.size,
        hygrosensory: forcedUniqueByClass.hygrosensory.size,
        gustatory: forcedUniqueByClass.gustatory.size,
      })}`,
      `observedAfferentSpikeEvents: ${observedAfferentSpikeEvents}`,
      `observedAfferentUniqueFired: ${observedAfferentUnique.size}`,
      `observedOlfactorySpikeEvents: ${observedOlfactorySpikeEvents}`,
      `observedOlfactoryUniqueFired: ${observedOlfactoryUnique.size}`,
      `outputReplayPath: ${outPath}`,
    ];
    fs.writeFileSync(summaryPath, `${summary.join('\n')}\n`, 'utf8');
    console.log(
      `[neurosim-baseline] done simId=${simId} ticks=${replayTicks.length} elapsedMs=${Date.now() - startedAt} out=${outPath} forcedUniqueAfferent=${forcedUniqueAfferent.size} observedAfferentUnique=${observedAfferentUnique.size} observedOlfactoryUnique=${observedOlfactoryUnique.size}`,
    );
    res.json({
      ok: true,
      ticks: replayTicks.length,
      outPath,
      summaryPath,
      overallSpikeEvents,
      overallUniqueFiredNeurons: overallUnique.size,
      epgSpikeEvents,
      epgUniqueFiredNeurons: epgUnique.size,
      forcedSpikeEvents,
      forcedUniqueAfferentIds: forcedUniqueAfferent.size,
      forcedUniqueByClass: {
        mechanosensory: forcedUniqueByClass.mechanosensory.size,
        thermosensory: forcedUniqueByClass.thermosensory.size,
        hygrosensory: forcedUniqueByClass.hygrosensory.size,
        gustatory: forcedUniqueByClass.gustatory.size,
      },
      observedAfferentSpikeEvents,
      observedAfferentUniqueFired: observedAfferentUnique.size,
      observedOlfactorySpikeEvents,
      observedOlfactoryUniqueFired: observedOlfactoryUnique.size,
    });
  } catch (err) {
    console.error('[neurosim-baseline] export error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/world', (_, res) => res.json(getWorld()));

app.use('/api/claim', claimsRouter);

app.post('/api/deploy', async (req, res) => {
  try {
    const address = parseAndValidateAddress(req.body?.address);
    const slotIndex = typeof req.body?.slotIndex === 'number' ? req.body.slotIndex : parseInt(String(req.body?.slotIndex ?? ''), 10);
    if (!address || !isValidSlotIndex(slotIndex)) {
      res.status(400).json({ error: 'Invalid address or slotIndex (0-2)' });
      return;
    }
    const userFlies = getFlies(address);
    if (!userFlies[slotIndex]) {
      res.status(400).json({ error: 'No fly in that slot; buy a fly first' });
      return;
    }
    let map = deployedFlies.get(address);
    if (map?.has(slotIndex)) {
      res.json({ success: true, simIndex: map.get(slotIndex), message: 'Already deployed' });
      return;
    }
    const simIndex = await addFlyToSim(`${address}:${slotIndex}`);
    if (!map) {
      map = new Map();
      deployedFlies.set(address, map);
    }
    map.set(slotIndex, simIndex);
    addDeployment(address, slotIndex);
    console.log('[deploy]', address.slice(0, 10) + '…', 'slot', slotIndex, '-> sim', simIndex);
    res.json({ success: true, simIndex });
  } catch (err) {
    console.error('[deploy] error:', err);
    res.status(500).json({ error: 'Deploy failed' });
  }
});

app.get('/api/rewards/stats', (req, res) => {
  try {
    const address = parseAndValidateAddress(req.query.address);
    if (!address) {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }
    const stats = getStatsForAddress(address);
    const rewardPerPointWei = REWARD_PER_POINT.toString();
    res.json({ stats, rewardPerPointWei });
  } catch (err) {
    console.error('[rewards] stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.get('/api/rewards/history', (req, res) => {
  try {
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 50);
    const history = getDistributedHistory(limit);
    res.json({ history });
  } catch (err) {
    console.error('[rewards] history error:', err);
    res.status(500).json({ error: 'Failed to get reward history' });
  }
});

app.get('/api/deploy/my-deployed', (req, res) => {
  try {
    const address = parseAndValidateAddress(req.query.address);
    if (!address) {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }
    const map = deployedFlies.get(address);
    const deployed: Record<number, number> = {};
    if (map) {
      for (const [slot, idx] of map) deployed[slot] = idx;
    }
    const currentFlies = getFlies(address);
    const graveyardSlots = Array.from(
      new Set(
        getDeployments()
          .filter(
            (d) =>
              d.address === address &&
              d.active === false &&
              isValidSlotIndex(d.slotIndex) &&
              currentFlies[d.slotIndex] == null
          )
          .map((d) => d.slotIndex),
      ),
    );
    res.json({ deployed, graveyardSlots });
  } catch (err) {
    console.error('[deploy] my-deployed error:', err);
    res.status(500).json({ error: 'Failed to get deployed flies' });
  }
});

app.get('/api/deploy/graveyard', (req, res) => {
  try {
    const address = parseAndValidateAddress(req.query.address);
    if (!address) {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }
    const pageRaw = Number(req.query.page ?? 1);
    const pageSizeRaw = Number(req.query.pageSize ?? 3);
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(pageSizeRaw, 20)
      : 3;

    const all = getDeployments()
      .filter(
        (d) => d.address === address && d.active === false && isValidSlotIndex(d.slotIndex)
      )
      .sort((a, b) => {
        const ta = new Date(a.deactivatedAt ?? a.timeDeployed ?? 0).getTime();
        const tb = new Date(b.deactivatedAt ?? b.timeDeployed ?? 0).getTime();
        return tb - ta;
      })
      .map((d) => {
        const flyId = d.flyId ?? `${address}-slot-${d.slotIndex}`;
        const stats = d.flyId ? getNeuroFlyStats(address, d.slotIndex, d.flyId) : undefined;
        const feedCount = stats?.feedCount ?? 0;
        return {
          flyId,
          slotIndex: d.slotIndex,
          feedCount,
          rewardWei: (BigInt(stats?.pointsEarnedMilli ?? 0) * (REWARD_PER_POINT / 1000n)).toString(),
          timeBirthed: stats?.timeBirthed,
          timeDeployed: d.timeDeployed ?? stats?.timeDeployed,
          removedAt: d.deactivatedAt ?? null,
        };
      });
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const clampedPage = Math.min(page, totalPages);
    const start = (clampedPage - 1) * pageSize;
    const items = all.slice(start, start + pageSize);

    res.json({ items, page: clampedPage, pageSize, total, totalPages });
  } catch (err) {
    console.error('[deploy] graveyard error:', err);
    res.status(500).json({ error: 'Failed to get graveyard flies' });
  }
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  clientViewFlyIndex.set(ws, 0);
  clientActivityCursor.set(ws, 0);
  console.log('[ws] client connected, total=', wsClients.size);

  const flies = sims.map((s) => s.getState().fly);
  const viewIndex = Math.max(0, Math.min(sims.length - 1, 0));
  const states = sims.map((s) => s.getState());
  const activities = states.map((s) => s.activity);
  const firstState = sims[0]?.getState();
  const viewedState = states[viewIndex];
  const motor = viewedState
    ? {
        left: viewedState.motorLeft ?? 0,
        right: viewedState.motorRight ?? 0,
        fwd: viewedState.motorFwd ?? 0,
        leftCount: viewedState.motorLeftCount ?? 0,
        rightCount: viewedState.motorRightCount ?? 0,
        fwdCount: viewedState.motorFwdCount ?? 0,
        leftMagnitude: viewedState.motorLeftMagnitude ?? 0,
        rightMagnitude: viewedState.motorRightMagnitude ?? 0,
        fwdMagnitude: viewedState.motorFwdMagnitude ?? 0,
      }
    : undefined;
  ws.send(JSON.stringify({
    frames: [{ t: firstState?.t ?? 0, flies }],
    activity: activities[viewIndex] ?? {},
    motor,
    sources: getSources(),
    simRunning,
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (typeof msg.viewFlyIndex === 'number') {
        clientViewFlyIndex.set(ws, Math.max(0, msg.viewFlyIndex));
        clientActivityCursor.set(ws, 0);
      }
    } catch {
      /* ignore */
    }
  });

  ws.on('close', () => {
    clientActivityCursor.delete(ws);
    clientViewFlyIndex.delete(ws);
    wsClients.delete(ws);
    console.log('[ws] client disconnected, total=', wsClients.size);
  });

  ws.on('error', (err) => {
    console.error('[ws] error', err);
  });
});

if (process.env.VITEST !== 'true') {
  httpServer.listen(PORT, () => {
    startSim();
    console.log('NeuroSim API http://localhost:' + PORT);
    console.log('WebSocket ws://localhost:' + PORT + '/ws');
    console.log(
      'Connectome:',
      connectome.neurons.length,
      'neurons,',
      connectome.connections.length,
      'connections, viewer subset:',
      viewerNeuronIndices.length,
    );
    const activeDeploymentCount = Array.from(deployedFlies.values()).reduce((sum, slots) => sum + slots.size, 0);
    console.log(
      '[sim] auto-started with',
      sims.length,
      'active sims from',
      activeDeploymentCount,
      'deployments; users deploy flies via POST /api/deploy',
    );
  });
}

/** Test-only: reset deploy state so tests can run independently. */
export function resetDeployStateForTesting(): void {
  deployedFlies.clear();
  sims.splice(0, sims.length);
  simActivityTrail.splice(0, simActivityTrail.length);
  clearForTesting();
}

export { app, httpServer, startSim, stopSim };
