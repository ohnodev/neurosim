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

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const SUBSET_ALIGNED_PATH = path.join(DATA_DIR, 'connectome-subset-aligned.json');
const SUBSET_PATH = path.join(DATA_DIR, 'connectome-subset.json');

/** Resolve default connectome path at call-time (avoids throwing at module load). */
export function resolveDefaultPath(): string {
  const envPath = process.env.NEUROSIM_CONNECTOME_PATH;
  return envPath
    ? path.resolve(envPath)
    : (fs.existsSync(SUBSET_ALIGNED_PATH) ? SUBSET_ALIGNED_PATH : SUBSET_PATH);
}

function validateConnectomePath(configured: string): void {
  if (!configured.toLowerCase().endsWith('.json')) {
    throw new Error(
      `[CRITICAL] Invalid NEUROSIM_CONNECTOME_PATH for API loader: expected a JSON file, got "${configured}". Refusing startup.`,
    );
  }
  if (!fs.existsSync(configured)) {
    throw new Error(
      `[CRITICAL] Connectome file not found: "${configured}". Refusing startup.`,
    );
  }
}

export function loadConnectome(p: string = resolveDefaultPath()): Connectome {
  validateConnectomePath(p);
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
    if (typeof c.weight !== 'number' || !Number.isFinite(c.weight)) continue;
    const list = adj.get(c.pre) ?? [];
    list.push({ post: c.post, weight: c.weight });
    adj.set(c.pre, list);
  }
  return adj;
}
