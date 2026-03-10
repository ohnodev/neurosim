import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadConnectome } from './connectome.js';
import { createBrainSim } from './brain-sim.js';
import { getWorld, spawnFood, removeFood, getSources } from './world.js';
import claimsRouter from './routes/claims.js';
import { getFlies } from './services/flyStore.js';

const PORT = Number(process.env.PORT) || 3001;
const connectome = loadConnectome();

const GROUND_Z = 0.35;
const INITIAL_SPREAD = 4;

spawnFood(); // initial food
setInterval(() => {
  const f = spawnFood();
  if (f) {
    console.log('[world] spawned food', f.id, 'at', f.x.toFixed(1), f.y.toFixed(1));
    broadcast({ simRunning, sources: getSources() });
  }
}, 10_000);

/** Simulation flies; starts empty, users deploy flies. */
const sims: ReturnType<typeof createBrainSim>[] = [];
/** address -> slotIndex -> simIndex */
const deployedFlies = new Map<string, Map<number, number>>();
let neuronIds: string[] = [];

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
  if (neuronIds.length === 0) neuronIds = sim.neuronIds;
  return sims.length - 1;
}
let simRunning = false;
let simIntervalId: ReturnType<typeof setInterval> | null = null;
const STEP_LOG_INTERVAL = 150;
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
  simIntervalId = setInterval(() => {
    const dt = 1 / 30;
    const flies: ReturnType<typeof sims[0]['getState']>['fly'][] = [];
    let t = 0;
    let activity: Record<string, number> | undefined;
    for (let i = 0; i < sims.length; i++) {
      const state = sims[i].step(dt);
      if (state.eatenFoodId) {
        removeFood(state.eatenFoodId);
        console.log('[world] fly', i, 'ate food', state.eatenFoodId);
      }
      flies.push(state.fly);
      t = state.t;
      if (i === 0) activity = state.activity;
    }
    broadcast({ t, flies, activity: activity ?? undefined, simRunning: true, sources: getSources() });
    connectionStep += 1;
    if (connectionStep % STEP_LOG_INTERVAL === 0) {
      const first = flies[0];
      console.log('[sim] t=', t.toFixed(1), 'flies=', flies.length, first ? `first=(${first.x?.toFixed(2)},${first.y?.toFixed(2)})` : '', 'clients=', wsClients.size);
    }
  }, 1000 / 30);
  console.log('[sim] started');
}

function stopSim(): void {
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
    console.log('[deploy]', address.slice(0, 10) + '…', 'slot', slotIndex, '-> sim', simIndex);
    res.json({ success: true, simIndex });
  } catch (err) {
    console.error('[deploy] error:', err);
    res.status(500).json({ error: 'Deploy failed' });
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
  const firstState = sims[0]?.getState();
  ws.send(JSON.stringify({
    t: firstState?.t ?? 0,
    flies,
    activity: firstState?.activity,
    simRunning,
    sources: getSources(),
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; neurons?: string[]; strength?: number };
      if (msg.type === 'stimulate') {
        const neurons = msg.neurons;
        let strength = msg.strength;
        if (!Array.isArray(neurons) || typeof strength !== 'number') {
          console.warn('[ws] stimulate: requires { neurons: string[], strength: number }');
          return;
        }
        if (!Number.isFinite(strength)) {
          console.warn('[ws] stimulate: strength must be finite');
          return;
        }
        strength = Math.max(0, Math.min(1, strength));
        const valid = neurons.filter((id) => neuronIds.includes(id));
        if (valid.length === 0) {
          console.warn('[ws] stimulate: no valid neuron IDs');
          return;
        }
        const target = sims[0];
        if (target) target.inject(valid, strength);
        console.log('[ws] stimulate neurons=', valid.length, 'strength=', strength);
      }
    } catch (err) {
      console.error('[ws] message error', err);
    }
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

export { app, httpServer, startSim };
