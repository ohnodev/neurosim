/**
 * Process FlyWire connectome CSVs from data/raw/ into a subset JSON.
 * Place connections.csv, neurons.csv, coordinates.csv in data/raw/ (from Kaggle download).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const DATA_RAW = path.join(process.cwd(), 'data', 'raw');
const OUTPUT = path.join(process.cwd(), 'data', 'connectome-subset.json');
const SUBSET_SIZE = 2000; // neurons to include
const MIN_SYNAPSES = 2;

type NeuronRole = 'sensory' | 'motor' | 'interneuron';
type NeuronSide = 'left' | 'right' | 'unknown';

interface Neuron {
  root_id: string;
  x?: number;
  y?: number;
  z?: number;
  role?: NeuronRole;
  side?: NeuronSide;
  cell_type?: string; // from classification.cell_type or consolidated.primary_type
  [k: string]: unknown;
}

interface Connection {
  pre: string;
  post: string;
  weight?: number;
}

function ensureDataDir() {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(DATA_RAW)) {
    fs.mkdirSync(DATA_RAW, { recursive: true });
    console.error(`\nMissing data. Please place FlyWire CSVs in:\n  ${DATA_RAW}\n`);
    console.error('Files needed: connections.csv, neurons.csv, coordinates.csv');
    console.error('Download from: https://www.kaggle.com/datasets/leonidblokhinrs/flywire-brain-dataset-fafb-v783/data\n');
    process.exit(1);
  }
}

function loadCsv(name: string): Record<string, string>[] {
  const p = path.join(DATA_RAW, name);
  if (!fs.existsSync(p)) return [];
  const buf = fs.readFileSync(p, 'utf-8');
  const rows = parse(buf, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  return rows;
}

/** Assign role from FlyWire flow + super_class. Falls back to interneuron. */
function inferRole(flow: string, superClass: string): NeuronRole {
  const flowLower = flow?.toLowerCase() ?? '';
  const sc = superClass?.toLowerCase() ?? '';
  if (flowLower === 'afferent') return 'sensory';
  if (flowLower === 'efferent') return 'motor';
  if (sc === 'sensory' || sc === 'optic' || sc === 'ascending' || sc === 'visual_projection') return 'sensory';
  if (sc === 'descending' || sc === 'motor') return 'motor';
  return 'interneuron';
}

function inferSide(side: string): NeuronSide {
  const s = side?.toLowerCase() ?? '';
  if (s === 'left') return 'left';
  if (s === 'right') return 'right';
  return 'unknown';
}

function inferIdCol(rows: Record<string, string>[], hints: string[]): string {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  for (const h of hints) {
    const c = cols.find((k) => k.toLowerCase().includes(h));
    if (c) return c;
  }
  return cols[0] ?? 'id';
}

function main() {
  ensureDataDir();

  const connectionsRaw = loadCsv('connections.csv');
  const neuronsRaw = loadCsv('neurons.csv');
  const coordsRaw = loadCsv('coordinates.csv');
  const classificationRaw = loadCsv('classification.csv');
  const consolidatedRaw = loadCsv('consolidated_cell_types.csv');

  if (connectionsRaw.length === 0) {
    console.error('connections.csv not found or empty. Place it in data/raw/');
    process.exit(1);
  }

  // Infer column names (FlyWire / Kaggle vary)
  const connCols = Object.keys(connectionsRaw[0] ?? {});
  const preCol = connCols.find((c) => /pre|presyn|source|presynaptic/i.test(c)) ?? connCols[0];
  const postCol = connCols.find((c) => /post|postsyn|target|postsynaptic/i.test(c)) ?? connCols[1];
  const weightCol = connCols.find((c) => /weight|syn_count|count|size/i.test(c));

  const connections: Connection[] = [];
  const allIds = new Set<string>();

  for (const row of connectionsRaw) {
    const pre = String(row[preCol] ?? '').trim();
    const post = String(row[postCol] ?? '').trim();
    if (!pre || !post) continue;
    const w = weightCol ? parseInt(row[weightCol] ?? '1', 10) : 1;
    if (w < MIN_SYNAPSES) continue;
    connections.push({ pre, post, weight: w });
    allIds.add(pre);
    allIds.add(post);
  }

  const idCol = inferIdCol(neuronsRaw.length ? neuronsRaw : coordsRaw, ['root_id', 'rootid', 'id', 'segment']);
  const coordCols = coordsRaw[0] ? Object.keys(coordsRaw[0]) : [];
  const xCol = coordCols.find((c) => /^x$|_x$/.test(c)) ?? 'x';
  const yCol = coordCols.find((c) => /^y$|_y$/.test(c)) ?? 'y';
  const zCol = coordCols.find((c) => /^z$|_z$/.test(c)) ?? 'z';

  const coordById = new Map<string, { x: number; y: number; z: number }>();
  for (const row of coordsRaw) {
    const id = String(row[idCol] ?? '').trim();
    if (!id) continue;
    const x = parseFloat(row[xCol] ?? '0');
    const y = parseFloat(row[yCol] ?? '0');
    const z = parseFloat(row[zCol] ?? '0');
    coordById.set(id, { x, y, z });
  }

  // Pick top-N neurons by connection count for subset
  const inDegree = new Map<string, number>();
  for (const c of connections) {
    inDegree.set(c.post, (inDegree.get(c.post) ?? 0) + (c.weight ?? 1));
  }
  const sorted = [...allIds].sort((a, b) => (inDegree.get(b) ?? 0) - (inDegree.get(a) ?? 0));
  const subsetIds = new Set(sorted.slice(0, SUBSET_SIZE));

  const classificationById = new Map<string, { flow: string; super_class: string; side: string; cell_type: string }>();
  const classIdCol = inferIdCol(classificationRaw, ['root_id', 'rootid', 'id']);
  const flowCol = Object.keys(classificationRaw[0] ?? {}).find((c) => /^flow$/i.test(c)) ?? 'flow';
  const superCol = Object.keys(classificationRaw[0] ?? {}).find((c) => /super_class/i.test(c)) ?? 'super_class';
  const sideCol = Object.keys(classificationRaw[0] ?? {}).find((c) => /^side$/i.test(c)) ?? 'side';
  const cellTypeCol = Object.keys(classificationRaw[0] ?? {}).find((c) => /cell_type|celltype/i.test(c)) ?? 'cell_type';
  for (const row of classificationRaw) {
    const id = String(row[classIdCol] ?? '').trim();
    if (!id) continue;
    classificationById.set(id, {
      flow: row[flowCol] ?? '',
      super_class: row[superCol] ?? '',
      side: row[sideCol] ?? '',
      cell_type: row[cellTypeCol] ?? '',
    });
  }

  const consolidatedById = new Map<string, string>();
  const consIdCol = inferIdCol(consolidatedRaw, ['root_id', 'rootid', 'id']);
  const primaryTypeCol = Object.keys(consolidatedRaw[0] ?? {}).find((c) => /primary_type|primarytype/i.test(c)) ?? 'primary_type';
  for (const row of consolidatedRaw) {
    const id = String(row[consIdCol] ?? '').trim();
    if (!id) continue;
    const pt = String(row[primaryTypeCol] ?? '').trim();
    if (pt) consolidatedById.set(id, pt);
  }

  const subsetConnections = connections.filter((c) => subsetIds.has(c.pre) && subsetIds.has(c.post));
  const neurons: Neuron[] = [];
  for (const id of subsetIds) {
    const coord = coordById.get(id);
    const cl = classificationById.get(id);
    const role = cl ? inferRole(cl.flow, cl.super_class) : 'interneuron';
    const side = cl ? inferSide(cl.side) : 'unknown';
    const cell_type = (cl?.cell_type?.trim() || consolidatedById.get(id)) || undefined;
    neurons.push({
      root_id: id,
      x: coord?.x,
      y: coord?.y,
      z: coord?.z,
      role,
      side,
      cell_type: cell_type || undefined,
    });
  }

  const out = { neurons, connections: subsetConnections, meta: { total_neurons: neurons.length, total_connections: subsetConnections.length } };
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${neurons.length} neurons, ${subsetConnections.length} connections -> ${OUTPUT}`);
}

main();
