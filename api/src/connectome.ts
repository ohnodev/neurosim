import * as fs from 'fs';
import * as path from 'path';

export type NeuronRole = 'sensory' | 'motor' | 'interneuron';
export type NeuronSide = 'left' | 'right' | 'unknown';

export interface Neuron {
  root_id: string;
  x?: number;
  y?: number;
  z?: number;
  role?: NeuronRole;
  side?: NeuronSide;
  cell_type?: string;
}

export interface Connection {
  pre: string;
  post: string;
  weight?: number;
}

export interface Connectome {
  neurons: Neuron[];
  connections: Connection[];
  meta: { total_neurons: number; total_connections: number };
}

const DEFAULT_PATH = path.resolve(process.cwd(), '..', 'data', 'connectome-subset.json');

export function loadConnectome(p: string = DEFAULT_PATH): Connectome {
  const buf = fs.readFileSync(p, 'utf-8');
  const data = JSON.parse(buf) as Connectome;
  if (!data.neurons?.length || !Array.isArray(data.connections)) {
    throw new Error(`Invalid connectome at ${p}: missing neurons or connections`);
  }
  return data;
}

export function buildAdjacency(connections: Connection[]): Map<string, { post: string; weight: number }[]> {
  const adj = new Map<string, { post: string; weight: number }[]>();
  for (const c of connections) {
    const list = adj.get(c.pre) ?? [];
    list.push({ post: c.post, weight: c.weight ?? 1 });
    adj.set(c.pre, list);
  }
  return adj;
}
