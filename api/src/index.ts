import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadConnectome } from './connectome.js';
import { createBrainSim } from './brain-sim.js';
import { getWorld } from './world.js';

const PORT = Number(process.env.PORT) || 3001;
const connectome = loadConnectome();
const world = getWorld();
let wsClientCount = 0;

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
  const ids = connectome.neurons.map((n) => n.root_id);
  res.json({ neurons: ids });
});

app.get('/api/world', (_, res) => res.json(world));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  wsClientCount += 1;
  console.log('[ws] client connected, total=', wsClientCount);

  const { step, inject, neuronIds } = createBrainSim(connectome, world.sources);
  let stimulateCount = 0;
  let connectionStep = 0;
  const STEP_LOG_INTERVAL = 150;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'stimulate') {
        const neurons = Array.isArray(msg.neurons) ? msg.neurons : [msg.neuron].filter(Boolean);
        const strength = typeof msg.strength === 'number' ? msg.strength : 0.8;
        const valid = neurons.filter((id: string) => neuronIds.includes(id));
        if (valid.length === 0) {
          console.warn('[ws] stimulate: no valid neuron IDs (invalid:', neurons, '), skipping');
          return;
        }
        inject(valid, strength);
        stimulateCount += 1;
        console.log('[ws] stimulate neurons=', valid.length, 'strength=', strength);
      }
    } catch (err) {
      console.error('[ws] message error', err);
    }
  });

  const interval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(interval);
      return;
    }
    const state = step(1 / 30);
    ws.send(JSON.stringify(state));
    connectionStep += 1;
    if (connectionStep % STEP_LOG_INTERVAL === 0) {
      console.log('[sim] step t=', state.t.toFixed(1), 'fly=', state.fly.x.toFixed(2), state.fly.y.toFixed(2), 'clients=', wsClientCount);
    }
  }, 1000 / 30);

  ws.on('close', () => {
    wsClientCount -= 1;
    clearInterval(interval);
    console.log('[ws] client disconnected, total=', wsClientCount, 'stimuli sent=', stimulateCount);
  });

  ws.on('error', (err) => {
    console.error('[ws] error', err);
  });
});

httpServer.listen(PORT, () => {
  console.log('NeuroSim API http://localhost:' + PORT);
  console.log('WebSocket ws://localhost:' + PORT + '/ws');
  console.log('World sources:', world.sources.length, '(food/light attractors)');
  console.log('Connectome loaded. Place CSVs in data/raw/ and run process-connectome for full dataset.');
});
