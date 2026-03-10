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
  try {
    const buf = fs.readFileSync(p, 'utf-8');
    return JSON.parse(buf) as Connectome;
  } catch {
    return getFallbackConnectome();
  }
}

function getFallbackConnectome(): Connectome {
  return {
    neurons: [
      { root_id: 'n1', x: 0, y: 0, z: 0, role: 'sensory' },
      { root_id: 'n2', x: 1, y: 0, z: 0, role: 'interneuron' },
      { root_id: 'n3', x: 2, y: 1, z: 0, role: 'interneuron' },
      { root_id: 'n4', x: 1, y: 2, z: 0, role: 'motor', side: 'left' },
      { root_id: 'n5', x: 0, y: 1, z: 0, role: 'motor', side: 'right' },
    ],
    connections: [
      { pre: 'n1', post: 'n2', weight: 5 },
      { pre: 'n2', post: 'n3', weight: 3 },
      { pre: 'n3', post: 'n4', weight: 4 },
      { pre: 'n4', post: 'n5', weight: 2 },
      { pre: 'n5', post: 'n1', weight: 3 },
    ],
    meta: { total_neurons: 5, total_connections: 5 },
  };
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
