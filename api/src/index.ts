import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadConnectome } from './connectome.js';
import { createBrainSim } from './brain-sim.js';
import { getWorld, spawnFood, removeFood, getSources, getLiveSourcesForSim } from './world.js';
import claimsRouter from './routes/claims.js';

const PORT = Number(process.env.PORT) || 3001;
const connectome = loadConnectome();

spawnFood(); // initial food
setInterval(() => {
  const f = spawnFood();
  if (f) {
    console.log('[world] spawned food', f.id, 'at', f.x.toFixed(1), f.y.toFixed(1));
    broadcast({ simRunning, sources: getSources() });
  }
}, 10_000);

const sim = createBrainSim(connectome, getLiveSourcesForSim());
const { step, inject, getState, neuronIds } = sim;
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
    const state = step(1 / 30);
    if (state.eatenFoodId) {
      removeFood(state.eatenFoodId);
      console.log('[world] fly ate food', state.eatenFoodId);
    }
    broadcast({ ...state, simRunning: true, sources: getSources() });
    connectionStep += 1;
    if (connectionStep % STEP_LOG_INTERVAL === 0) {
      console.log('[sim] t=', state.t.toFixed(1), 'fly=', state.fly.x.toFixed(2), state.fly.y.toFixed(2), 'clients=', wsClients.size);
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

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log('[ws] client connected, total=', wsClients.size);

  const state = getState();
  ws.send(JSON.stringify({ ...state, simRunning, sources: getSources() }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; neurons?: string[]; strength?: number };
      if (msg.type === 'start') {
        startSim();
        return;
      }
      if (msg.type === 'stop') {
        stopSim();
        return;
      }
      if (msg.type !== 'stimulate') return;
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
      const MIN_STRENGTH = 0;
      const MAX_STRENGTH = 1;
      const orig = strength;
      strength = Math.max(MIN_STRENGTH, Math.min(MAX_STRENGTH, strength));
      if (orig !== strength) {
        console.warn(`[ws] stimulate: strength clamped from ${orig} to ${strength}`);
      }
      const valid = neurons.filter((id) => neuronIds.includes(id));
      if (valid.length === 0) {
        console.warn('[ws] stimulate: no valid neuron IDs');
        return;
      }
      inject(valid, strength);
      console.log('[ws] stimulate neurons=', valid.length, 'strength=', strength);
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

httpServer.listen(PORT, () => {
  console.log('NeuroSim API http://localhost:' + PORT);
  console.log('WebSocket ws://localhost:' + PORT + '/ws');
  console.log('Connectome:', connectome.neurons.length, 'neurons,', connectome.connections.length, 'connections');
});
