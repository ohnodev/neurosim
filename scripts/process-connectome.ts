/**
 * Process FlyWire connectome CSVs from data/raw/ into a subset JSON.
 * Requires: connections.csv, coordinates.csv, classification.csv, consolidated_cell_types.csv
 *
 * By default outputs top SUBSET_SIZE neurons by in-degree. Use --all (or SUBSET_SIZE=0)
 * to include every neuron and all connections; expect large output and longer runtime.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const DATA_RAW = path.join(process.cwd(), 'data', 'raw');
const OUTPUT = path.resolve(process.cwd(), process.env.OUTPUT_PATH || 'data/connectome-subset.json');
const DEFAULT_SUBSET_SIZE = 10000; // curated subset for movement/odor/visual/feeding (use --all for full)
const MIN_SYNAPSES = 2;

const useAll = process.argv.includes('--all') || process.env.SUBSET_SIZE === '0';
const SUBSET_SIZE = useAll ? 0 : (Number(process.env.SUBSET_SIZE) || DEFAULT_SUBSET_SIZE);

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
    console.error('Files needed: connections.csv, coordinates.csv, classification.csv, consolidated_cell_types.csv');
    console.error('Download from: https://www.kaggle.com/datasets/leonidblokhinrs/flywire-brain-dataset-fafb-v783/data\n');
    process.exit(1);
  }
}

function loadCsv(name: string): Record<string, string>[] {
  const p = path.join(DATA_RAW, name);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${name}. Place FlyWire CSVs in ${DATA_RAW}`);
  }
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

/** Relevance score for movement, odor, visual, feeding, reward. Higher = more relevant. */
function relevanceScore(role: NeuronRole, cellType: string, primaryType: string, superClass: string): number {
  let s = 0;
  const t = (cellType + ' ' + primaryType).trim();
  const sc = superClass?.toLowerCase() ?? '';
  if (role === 'motor') s += 10;
  if (role === 'sensory') s += 6;
  if (sc === 'optic' || sc === 'visual_projection') s += 8;
  if (/R[1-8]|T[45][a-d]?|L[1-5]|Dm\d|Mi\d|Tm\d|C[23]|MeTu/i.test(t)) s += 8; // visual
  if (/^OR|olfact|antennal|smell|AN_/i.test(t) || /olfact|antennal/i.test(sc)) s += 7; // odor
  if (/DAN|MB|KC|reward|dopamin/i.test(t)) s += 5; // reward
  if (s === 0) s = 1; // interneurons still get a base score
  return s;
}

/** Combined score: relevance × connectivity. Picks neurons that are both relevant and well connected. */
function combinedScore(relevance: number, inDegree: number): number {
  return relevance * Math.log2(1 + inDegree); // both matter; hubs within each type rank higher
}

function inferIdCol(rows: Record<string, string>[], hints: string[]): string {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  for (const h of hints) {
    const c = cols.find((k) => k.toLowerCase().includes(h));
    if (c) return c;
  }
  if (cols.length === 0) throw new Error('CSV has no columns');
  return cols[0];
}

function main() {
  ensureDataDir();

  const connectionsRaw = loadCsv('connections.csv');
  const coordsRaw = loadCsv('coordinates.csv');
  const classificationRaw = loadCsv('classification.csv');
  const consolidatedRaw = loadCsv('consolidated_cell_types.csv');

  if (connectionsRaw.length === 0 || coordsRaw.length === 0 || classificationRaw.length === 0 || consolidatedRaw.length === 0) {
    console.error('connections.csv, coordinates.csv, classification.csv, consolidated_cell_types.csv must exist and be non-empty');
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
    const raw = weightCol ? parseInt(row[weightCol] ?? '1', 10) : 1;
    if (!Number.isFinite(raw) || raw < MIN_SYNAPSES) continue;
    const w = raw;
    connections.push({ pre, post, weight: w });
    allIds.add(pre);
    allIds.add(post);
  }

  const idCol = inferIdCol(coordsRaw, ['root_id', 'rootid', 'id', 'segment']);
  const coordCols = coordsRaw[0] ? Object.keys(coordsRaw[0]) : [];
  const xCol = coordCols.find((c) => /^x$|_x$/.test(c));
  const yCol = coordCols.find((c) => /^y$|_y$/.test(c));
  const zCol = coordCols.find((c) => /^z$|_z$/.test(c));
  const posCol = coordCols.find((c) => /^position$/i.test(c));

  const coordById = new Map<string, { x: number; y: number; z: number }>();
  for (const row of coordsRaw) {
    const id = String(row[idCol] ?? '').trim();
    if (!id) continue;
    let x = 0, y = 0, z = 0;
    if (xCol && yCol && zCol && row[xCol] != null && row[yCol] != null && row[zCol] != null) {
      x = parseFloat(String(row[xCol])) || 0;
      y = parseFloat(String(row[yCol])) || 0;
      z = parseFloat(String(row[zCol])) || 0;
    } else if (posCol && row[posCol]) {
      // FlyWire format: "[352484 175164 229040]"
      const m = String(row[posCol]).match(/\[?\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\]?/);
      if (m) {
        x = parseFloat(m[1]) || 0;
        y = parseFloat(m[2]) || 0;
        z = parseFloat(m[3]) || 0;
      }
    }
    coordById.set(id, { x, y, z });
  }

  // Pick neurons: either all (--all / SUBSET_SIZE=0) or top-N by in-degree
  let subsetIds: Set<string>;
  let subsetConnections: Connection[];
  if (useAll) {
    subsetIds = new Set(allIds);
    subsetConnections = connections;
  } else {
    const inDegree = new Map<string, number>();
    for (const c of connections) {
      inDegree.set(c.post, (inDegree.get(c.post) ?? 0) + (c.weight ?? 1));
    }
    const classificationByIdTemp = new Map<string, { flow: string; super_class: string; side: string; cell_type: string }>();
    const classIdColTemp = inferIdCol(classificationRaw, ['root_id', 'rootid', 'id']);
    const flowColTemp = Object.keys(classificationRaw[0] ?? {}).find((c) => /^flow$/i.test(c)) ?? 'flow';
    const superColTemp = Object.keys(classificationRaw[0] ?? {}).find((c) => /super_class/i.test(c)) ?? 'super_class';
    const sideColTemp = Object.keys(classificationRaw[0] ?? {}).find((c) => /^side$/i.test(c)) ?? 'side';
    const cellTypeColTemp = Object.keys(classificationRaw[0] ?? {}).find((c) => /cell_type|celltype/i.test(c)) ?? 'cell_type';
    for (const row of classificationRaw) {
      const id = String(row[classIdColTemp] ?? '').trim();
      if (!id) continue;
      classificationByIdTemp.set(id, {
        flow: row[flowColTemp] ?? '',
        super_class: row[superColTemp] ?? '',
        side: row[sideColTemp] ?? '',
        cell_type: row[cellTypeColTemp] ?? '',
      });
    }
    const consolidatedTemp = new Map<string, string>();
    const consIdTemp = inferIdCol(consolidatedRaw, ['root_id', 'rootid', 'id']);
    const primaryColTemp = Object.keys(consolidatedRaw[0] ?? {}).find((c) => /primary_type|primarytype/i.test(c)) ?? 'primary_type';
    for (const row of consolidatedRaw) {
      const id = String(row[consIdTemp] ?? '').trim();
      if (id) consolidatedTemp.set(id, String(row[primaryColTemp] ?? '').trim());
    }
    const scored = [...allIds].map((id) => {
      const cl = classificationByIdTemp.get(id);
      const role = cl ? inferRole(cl.flow, cl.super_class) : 'interneuron';
      const primary = consolidatedTemp.get(id) ?? '';
      const rel = relevanceScore(role, cl?.cell_type ?? '', primary, cl?.super_class ?? '');
      const deg = inDegree.get(id) ?? 0;
      return { id, combined: combinedScore(rel, deg), deg };
    });
    scored.sort((a, b) => b.combined - a.combined);
    subsetIds = new Set(scored.slice(0, SUBSET_SIZE).map((x) => x.id));
    subsetConnections = connections.filter((c) => subsetIds.has(c.pre) && subsetIds.has(c.post));
  }

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
