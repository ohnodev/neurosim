import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadConnectome } from './connectome.js';
import { createBrainSim } from './brain-sim.js';
import { getWorld, spawnFood, removeFood, getSources, type WorldSource } from './world.js';
import claimsRouter from './routes/claims.js';
import { getFlies } from './services/flyStore.js';
import { getDeployments, addDeployment, clearForTesting } from './services/deployStore.js';
import { recordFoodCollected, getStatsForAddress, getDistributedHistory, REWARD_PER_FOOD } from './services/rewardStore.js';
import { flushRewards } from './services/rewardDistributor.js';

const PORT = Number(process.env.PORT) || 3001;
const connectome = loadConnectome();

const GROUND_Z = 0.35;
const INITIAL_SPREAD = 4;

let foodIntervalId: ReturnType<typeof setInterval> | null = null;
let rewardFlushIntervalId: ReturnType<typeof setInterval> | null = null;

/** Simulation flies; starts empty, users deploy flies. */
const sims: ReturnType<typeof createBrainSim>[] = [];
/** address -> slotIndex -> simIndex */
const deployedFlies = new Map<string, Map<number, number>>();

function addFlyToSim(): number {
  const angle = (2 * Math.PI * sims.length) / Math.max(1, sims.length + 1);
  const x = INITIAL_SPREAD * Math.cos(angle);
  const y = INITIAL_SPREAD * Math.sin(angle);
  const sim = createBrainSim(connectome, () => getSources(), {
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

function restoreDeployFromStore(): void {
  const records = getDeployments();
  for (const { address, slotIndex } of records) {
    const simIndex = addFlyToSim();
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

const wsClients = new Set<import('ws').WebSocket>();

function broadcast(data: unknown): void {
  const payload = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function startSim(): void {
  if (simRunning) return;
  simRunning = true;
  connectionStep = 0;
  spawnFood();
  foodIntervalId = setInterval(() => {
    const f = spawnFood();
    if (f) {
      console.log('[world] spawned food', f.id, 'at', f.x.toFixed(1), f.y.toFixed(1));
      broadcast({ simRunning, sources: getSources() });
    }
  }, 10_000);
  simIntervalId = setInterval(() => {
    const dt = 1 / SIM_FPS;
    const frames: { t: number; flies: ReturnType<typeof sims[0]['getState']>['fly'][]; activities: (Record<string, number> | undefined)[]; activity?: Record<string, number>; sources: WorldSource[] }[] = [];
    for (let i = 0; i < FRAMES_PER_BATCH; i++) {
      const flies: ReturnType<typeof sims[0]['getState']>['fly'][] = [];
      const activities: (Record<string, number> | undefined)[] = [];
      let t = 0;
      for (let j = 0; j < sims.length; j++) {
        const state = sims[j].step(dt);
        if (state.eatenFoodId) {
          removeFood(state.eatenFoodId);
          recordFoodCollected(j);
          console.log('[world] fly', j, 'ate food', state.eatenFoodId);
        }
        flies.push(state.fly);
        activities.push(state.activity);
        t = state.t;
      }
      frames.push({ t, flies, activities, activity: activities[0], sources: getSources() });
    }
    broadcast({ frames, simRunning: true, sources: getSources() });
    connectionStep += 1;
    if (connectionStep % 15 === 0) {
      const last = frames[frames.length - 1];
      const first = last?.flies[0];
      console.log('[sim] t=', last?.t.toFixed(1), 'flies=', last?.flies.length ?? 0, first ? `first=(${first.x?.toFixed(2)},${first.y?.toFixed(2)})` : '', 'clients=', wsClients.size);
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

app.get('/api/health', (_, res) => res.json({ ok: true }));

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

app.post('/api/deploy', (req, res) => {
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
    const simIndex = addFlyToSim();
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
    res.json({ deployed });
  } catch (err) {
    console.error('[deploy] my-deployed error:', err);
    res.status(500).json({ error: 'Failed to get deployed flies' });
  }
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log('[ws] client connected, total=', wsClients.size);

  const flies = sims.map((s) => s.getState().fly);
  const activities = sims.map((s) => s.getState().activity);
  const firstState = sims[0]?.getState();
    ws.send(JSON.stringify({
    frames: [{ t: firstState?.t ?? 0, flies, activities, activity: activities[0], sources: getSources() }],
    simRunning,
    sources: getSources(),
  }));

  ws.on('message', () => {
    /* Client sends no messages; sim runs server-side */
  });

  ws.on('close', () => {
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
