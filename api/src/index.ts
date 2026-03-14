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
import { recordFoodCollected, getStatsForAddress, getDistributedHistory, REWARD_PER_FOOD } from './services/rewardStore.js';
import { flushRewards } from './services/rewardDistributor.js';

const PORT = Number(process.env.PORT) || 3001;
const connectome = loadConnectome();

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

let foodIntervalId: ReturnType<typeof setInterval> | null = null;
let rewardFlushIntervalId: ReturnType<typeof setInterval> | null = null;

/** Simulation flies; starts empty, users deploy flies. */
const sims: Awaited<ReturnType<typeof createBrainSim>>[] = [];
/** address -> slotIndex -> simIndex */
const deployedFlies = new Map<string, Map<number, number>>();

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

function parseRequesterAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) return null;
  return normalized;
}

async function addFlyToSim(): Promise<number> {
  const angle = (2 * Math.PI * sims.length) / Math.max(1, sims.length + 1);
  const x = INITIAL_SPREAD * Math.cos(angle);
  const y = INITIAL_SPREAD * Math.sin(angle);
  const sim = await createBrainSim(connectome, () => getSources(), {
    x,
    y,
    z: GROUND_Z,
    heading: 0,
    t: 0,
    hunger: 100,
    health: 100,
  });
  sims.push(sim);
  return sims.length - 1;
}

async function restoreDeployFromStore(): Promise<void> {
  const records = getDeployments().filter((r) => r.active !== false);
  for (const { address, slotIndex } of records) {
    const simIndex = await addFlyToSim();
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
let simRunning = false;
let simIntervalId: ReturnType<typeof setInterval> | null = null;
/** 250ms interval; client keeps 1s buffer for smooth interpolation */
const SIM_FPS = 30;
const BATCH_MS = 250;
const FRAMES_PER_BATCH = Math.round(SIM_FPS * BATCH_MS / 1000);
let connectionStep = 0;
let nextBatchDueAt = 0;
let simTickInFlight = false;
let droppedSimTicks = 0;

const wsClients = new Set<import('ws').WebSocket>();
/** Per-client: which fly's activity to send (sim index). Default 0. */
const clientViewFlyIndex = new Map<import('ws').WebSocket, number>();

function broadcast(data: unknown): void {
  const payload = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

/** Build per-client payload. Activity and sources sent once per batch (client only uses last). */
function buildClientPayload(
  frames: { t: number; flies: ReturnType<typeof sims[0]['getState']>['fly'][]; activities: (Record<string, number> | undefined)[] }[],
): void {
  const sources = getSources();
  const clientFrames = frames.map((f) => ({ t: f.t, flies: f.flies }));
  const lastFrame = frames[frames.length - 1];
  for (const ws of wsClients) {
    if (ws.readyState !== 1) continue;
    const viewIndex = Math.max(0, Math.min(sims.length - 1, clientViewFlyIndex.get(ws) ?? 0));
    const activity = lastFrame ? (lastFrame.activities[viewIndex] ?? {}) : {};
    try {
      ws.send(JSON.stringify({ frames: clientFrames, activity, sources, simRunning: true }));
    } catch (err) {
      console.error('[ws] send error', err);
    }
  }
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
  }, 10_000);
  simIntervalId = setInterval(async () => {
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
      const frames: { t: number; flies: ReturnType<typeof sims[0]['getState']>['fly'][]; activities: (Record<string, number> | undefined)[] }[] = [];

      const transitions: Array<{
        fromFly: ReturnType<typeof sims[0]['getState']>['fly'];
        toFly: ReturnType<typeof sims[0]['getState']>['fly'];
        fromT: number;
        toT: number;
        activity?: Record<string, number>;
      }> = [];

      const beforeStates = sims.map((s) => s.getState());
      const states = await Promise.all(sims.map((s) => s.step(batchDt)));
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
          recordFoodCollected(j);
          console.log('[world] fly', j, 'ate food', state.eatenFoodId);
        }
        transitions.push({
          fromFly: before.fly,
          toFly: state.fly,
          fromT: before.t,
          toT: state.t,
          activity: state.activity,
        });
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
        const t = transitions.length ? lerp(transitions[0].fromT, transitions[0].toT, alpha) : 0;
        frames.push({ t, flies, activities });
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
  rewardFlushIntervalId = setInterval(() => void flushRewards(), 60_000);
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

app.get('/api/neurons', (_, res) => {
  const neurons = connectome.neurons.map((n) => ({
    root_id: n.root_id,
    role: n.role,
    side: n.side,
    cell_type: n.cell_type,
    ...(n.x != null && { x: n.x }),
    ...(n.y != null && { y: n.y }),
    ...(n.z != null && { z: n.z }),
  }));
  res.json({ neurons });
});

app.get('/api/world', (_, res) => res.json(getWorld()));

app.use('/api/claim', claimsRouter);

app.post('/api/deploy', async (req, res) => {
  try {
    const address = (req.body?.address as string)?.toLowerCase();
    const slotIndex = typeof req.body?.slotIndex === 'number' ? req.body.slotIndex : parseInt(String(req.body?.slotIndex ?? ''), 10);
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address) || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 2) {
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
    const simIndex = await addFlyToSim();
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

app.post('/api/deploy/send-to-graveyard', (req, res) => {
  try {
    const address = (req.body?.address as string)?.toLowerCase();
    const requesterAddress = parseRequesterAddress(
      req.body?.requesterAddress ?? req.header('x-wallet-address')
    );
    const slotIndex = typeof req.body?.slotIndex === 'number' ? req.body.slotIndex : parseInt(String(req.body?.slotIndex ?? ''), 10);
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address) || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 2) {
      res.status(400).json({ error: 'Invalid address or slotIndex (0-2)' });
      return;
    }
    if (!requesterAddress || requesterAddress !== address) {
      res.status(403).json({ error: 'Requester does not own target address' });
      return;
    }
    if (!getFlies(address)[slotIndex]) {
      res.status(400).json({ error: 'No fly in that slot' });
      return;
    }

    const simIndex = deployedFlies.get(address)?.get(slotIndex);
    if (simIndex != null) {
      const removedSim = removeSimAtIndex(simIndex);
      if (!removedSim || removedSim.address !== address || removedSim.slotIndex !== slotIndex) {
        res.status(500).json({ error: 'Failed to remove live simulation state' });
        return;
      }
    }

    const removed = removeFlyAtSlot(address, slotIndex);
    if (!removed) {
      res.status(400).json({ error: 'No fly in that slot' });
      return;
    }

    deactivateDeployment(address, slotIndex);
    console.log('[graveyard]', address.slice(0, 10) + '…', 'slot', slotIndex, 'fly', removed.id);
    res.json({ success: true, removedFlyId: removed.id, slotIndex });
  } catch (err) {
    console.error('[graveyard] error:', err);
    res.status(500).json({ error: 'Failed to move fly to graveyard' });
  }
});

app.get('/api/rewards/stats', (req, res) => {
  try {
    const rawAddress = req.query.address;
    if (Array.isArray(rawAddress) || typeof rawAddress !== 'string') {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }
    const address = rawAddress.toLowerCase();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }
    const stats = getStatsForAddress(address);
    const rewardPerPointWei = REWARD_PER_FOOD.toString();
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
    const address = (req.query.address as string)?.toLowerCase();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }
    const map = deployedFlies.get(address);
    const deployed: Record<number, number> = {};
    if (map) {
      for (const [slot, idx] of map) deployed[slot] = idx;
    }
    const graveyardSlots = Array.from(
      new Set(
        getDeployments()
          .filter((d) => d.address === address && d.active === false)
          .map((d) => d.slotIndex),
      ),
    );
    res.json({ deployed, graveyardSlots });
  } catch (err) {
    console.error('[deploy] my-deployed error:', err);
    res.status(500).json({ error: 'Failed to get deployed flies' });
  }
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  clientViewFlyIndex.set(ws, 0);
  console.log('[ws] client connected, total=', wsClients.size);

  const flies = sims.map((s) => s.getState().fly);
  const viewIndex = Math.max(0, Math.min(sims.length - 1, 0));
  const activities = sims.map((s) => s.getState().activity);
  const firstState = sims[0]?.getState();
  ws.send(JSON.stringify({
    frames: [{ t: firstState?.t ?? 0, flies }],
    activity: activities[viewIndex] ?? {},
    sources: getSources(),
    simRunning,
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (typeof msg.viewFlyIndex === 'number') {
        clientViewFlyIndex.set(ws, Math.max(0, msg.viewFlyIndex));
      }
    } catch {
      /* ignore */
    }
  });

  ws.on('close', () => {
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
    console.log('Connectome:', connectome.neurons.length, 'neurons,', connectome.connections.length, 'connections');
    console.log('[sim] auto-started with 0 flies; users deploy flies via POST /api/deploy');
  });
}

/** Test-only: reset deploy state so tests can run independently. */
export function resetDeployStateForTesting(): void {
  deployedFlies.clear();
  sims.splice(0, sims.length);
  clearForTesting();
}

export { app, httpServer, startSim, stopSim };
