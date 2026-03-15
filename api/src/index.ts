import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadConnectome } from './connectome.js';
import { createBrainSim } from './brain-sim.js';
import * as socketClient from './brain-socket-client.js';
import { getWorld, spawnFood, removeFood, getSources, type WorldSource } from './world.js';
import claimsRouter from './routes/claims.js';
import { getFlies, removeFlyAtSlot } from './services/flyStore.js';
import { getDeployments, addDeployment, clearForTesting, deactivateDeployment } from './services/deployStore.js';
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
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_SLOT_INDEX = 2;
const VIEWER_NEURON_LIMIT = Math.max(1, Number(process.env.NEUROSIM_VIEWER_NEURON_LIMIT ?? 10_000));
const CLIENT_ACTIVITY_LIMIT = Math.max(1, Number(process.env.NEUROSIM_CLIENT_ACTIVITY_LIMIT ?? 1_000));
const CLIENT_ACTIVITY_TTL_MS = Math.max(250, Number(process.env.NEUROSIM_CLIENT_ACTIVITY_TTL_MS ?? 4_000));
const CLIENT_ACTIVITY_FLOOR = Math.min(0.4, Math.max(0.01, Number(process.env.NEUROSIM_CLIENT_ACTIVITY_FLOOR ?? 0.08)));
const CLIENT_INPUT_ACTIVITY_DEFAULT = Math.min(0.9, Math.max(CLIENT_ACTIVITY_FLOOR, Number(process.env.NEUROSIM_CLIENT_INPUT_ACTIVITY ?? 0.55)));

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

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

/** Brain sim uses Unix socket only. Probe connects to brain-service; retry a few times for PM2 start-order. */
const CUDA_ONLY = process.env.NEUROSIM_MODE === 'cuda' || process.env.USE_CUDA === '1';
const PROBE_RETRIES = 10;
const PROBE_DELAY_MS = 2000;

let backendInfo = { rust: true, gpu: process.env.USE_CUDA === '1' };
let probeOk = false;
for (let i = 0; i < PROBE_RETRIES; i++) {
  try {
    await socketClient.ping();
    console.log('[backend] handshake: API ↔ brain-service OK');
    backendInfo = { rust: true, gpu: process.env.USE_CUDA === '1' };
    probeOk = true;
    break;
  } catch (e) {
    if (i === PROBE_RETRIES - 1) {
      console.error('[backend] Brain service (Unix socket) unavailable after', PROBE_RETRIES, 'retries. Is neurosim-brain running?', e);
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
console.log(`[backend] brain=unix-socket rust=${backendInfo.rust} gpu=${backendInfo.gpu} mode=${CUDA_ONLY ? 'cuda-only' : 'auto'}`);

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
/** 250ms interval; client keeps 1s buffer for smooth interpolation */
const SIM_FPS = 30;
const BATCH_MS = 250;
const FRAMES_PER_BATCH = Math.round(SIM_FPS * BATCH_MS / 1000);
const BRAIN_INIT_GRACE_MS = Number(process.env.NEUROSIM_BRAIN_INIT_GRACE_MS ?? 10_000);
let connectionStep = 0;
let nextBatchDueAt = 0;
let simTickInFlight = false;
let droppedSimTicks = 0;
let simReadyAtMs = 0;

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
  }[],
): void {
  const nowMs = Date.now();
  const sources = getSources();
  const clientFrames = frames.map((f) => ({ t: f.t, flies: f.flies }));
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
      const batchDt = dtFrame * FRAMES_PER_BATCH;
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
      }> = [];

      const beforeStates = sims.map((s) => s.getState());
      const viewedSimIndexes = new Set<number>();
      if (wsClients.size > 0) {
        for (const ws of wsClients) {
          const idx = Math.max(0, Math.min(sims.length - 1, clientViewFlyIndex.get(ws) ?? 0));
          viewedSimIndexes.add(idx);
        }
      }
      const states = await Promise.all(
        sims.map((s, idx) => s.step(batchDt, { includeActivity: viewedSimIndexes.has(idx) })),
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
        transitions.push({
          fromFly: before.fly,
          toFly: state.fly,
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
        });
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
        frames.push({ t, flies, activities, inputActivities, motorReadouts });
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
        const timingStr = backendInfo.rust
          ? ` stepMs=${stepMs} jsMs=${jsMs} avgStep=${avgStep} avgJs=${avgJs} maxStep=${maxStepMs} maxJs=${maxJsMs} socketRoundtripMs=${socketRoundtripMs} socketWaitMs=${socketWaitMs} avgSocketRoundtrip=${avgSocketRoundtrip} avgSocketWait=${avgSocketWait} batchCalls=${batchCalls} batchSize=${batchSize} rustCalls=${rustCalls} synthFrames=${FRAMES_PER_BATCH} payloadMs=${buildPayloadMs} schedulerLagMs=${schedulerLagMs} droppedTicks=${droppedSimTicks}`
          : '';
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
  res.json({ ok: true, backend: { rust: backendInfo.rust, gpu: backendInfo.gpu } }));

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
  const neurons = connectome.neurons
    .filter((_, i) => full || viewerNeuronIndexSet.has(i))
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
    viewerNeuronLimit: VIEWER_NEURON_LIMIT,
    viewerNeuronCount: viewerNeuronIndices.length,
    totalNeuronCount: connectome.neurons.length,
  });
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
