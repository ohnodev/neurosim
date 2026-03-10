import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadConnectome } from './connectome.js';
import { createBrainSim } from './brain-sim.js';

const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(cors());
app.use(express.json());

const connectome = loadConnectome();

app.get('/api/connectome', (_, res) => {
  res.json({
    neurons: connectome.neurons.length,
    connections: connectome.connections.length,
    meta: connectome.meta,
  });
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

// Stimuli are applied per WebSocket session; this returns the neuron list for reference
app.get('/api/neurons', (_, res) => {
  const ids = connectome.neurons.map((n) => n.root_id);
  res.json({ neurons: ids });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  const { step, inject, neuronIds } = createBrainSim(connectome);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'stimulate') {
        const neurons = Array.isArray(msg.neurons) ? msg.neurons : [msg.neuron].filter(Boolean);
        const strength = typeof msg.strength === 'number' ? msg.strength : 0.8;
        const valid = neurons.filter((id: string) => neuronIds.includes(id));
        if (valid.length === 0) {
          valid.push(neuronIds[Math.floor(Math.random() * neuronIds.length)]);
        }
        inject(valid, strength);
      }
    } catch {}
  });
  const interval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(interval);
      return;
    }
    const state = step(1 / 30);
    ws.send(JSON.stringify(state));
  }, 1000 / 30);
  ws.on('close', () => clearInterval(interval));
});

httpServer.listen(PORT, () => {
  console.log(`NeuroSim API http://localhost:${PORT}`);
  console.log(`WebSocket ws://localhost:${PORT}/ws`);
  console.log('Connectome loaded. Place CSVs in data/raw/ and run process-connectome for full dataset.');
});
