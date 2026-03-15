import * as fs from 'node:fs';
import * as path from 'node:path';

type ReplayNeuron = {
  root_id: string;
  x: number;
  y: number;
  z: number;
  is_ring: boolean;
  side: string;
  hemibrain_type: string;
};

type ReplayTick = {
  tick: number;
  time_sec: number;
  spikes: string[];
};

type ReplayData = {
  meta: {
    generated_at: string;
    source_csv: string;
    ticks: number;
    unique_fired_neurons: number;
    ring_neuron_total: number;
    ring_neuron_unique_fired: number;
  };
  neurons: ReplayNeuron[];
  ticks: ReplayTick[];
};

const ROOT = path.resolve(process.cwd(), '..');
const CLASSIFICATION_PATH = path.join(ROOT, 'data', 'raw', 'classification.csv');
const CONNECTOME_PATH = path.join(ROOT, 'data', 'connectome-full.json');
const INPUT_SPIKES_PATH = process.env.INPUT_SPIKES_CSV
  ? path.resolve(process.env.INPUT_SPIKES_CSV)
  : path.join(ROOT, 'logs', 'eonsystems_baseline_spikes_per_tick.csv');
const OUT_JSON_LOGS = process.env.OUTPUT_REPLAY_JSON
  ? path.resolve(process.env.OUTPUT_REPLAY_JSON)
  : path.join(ROOT, 'logs', 'eonsystems_brain_subset_replay.json');
const OUT_SUMMARY = process.env.OUTPUT_SUMMARY
  ? path.resolve(process.env.OUTPUT_SUMMARY)
  : path.join(ROOT, 'logs', 'eonsystems_brain_subset_summary.txt');
const OUT_JSON_PUBLIC = process.env.OUTPUT_PUBLIC_REPLAY_JSON
  ? path.resolve(process.env.OUTPUT_PUBLIC_REPLAY_JSON)
  : path.join(ROOT, 'world', 'public', 'eonsystems_brain_subset_replay.json');

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function loadRingMetadata(): Map<string, { side: string; hemibrain_type: string }> {
  const text = fs.readFileSync(CLASSIFICATION_PATH, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const out = new Map<string, { side: string; hemibrain_type: string }>();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i] ?? '');
    if (cols.length < 9) continue;
    const rootId = cols[0] ?? '';
    const flow = (cols[1] ?? '').trim();
    const superClass = (cols[2] ?? '').trim();
    const neuronClass = (cols[3] ?? '').trim();
    const subClass = (cols[4] ?? '').trim();
    const hemibrainType = (cols[6] ?? '').trim();
    const side = (cols[8] ?? '').trim();
    if (!rootId) continue;
    if (subClass !== 'ring_neuron') continue;
    if (flow !== 'intrinsic' || superClass !== 'central' || neuronClass !== 'CX') continue;
    out.set(rootId, { side, hemibrain_type: hemibrainType });
  }
  return out;
}

function loadPositionMap(): Map<string, { x: number; y: number; z: number; side: string; cell_type: string }> {
  const raw = fs.readFileSync(CONNECTOME_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { neurons?: Array<Record<string, unknown>> };
  const out = new Map<string, { x: number; y: number; z: number; side: string; cell_type: string }>();
  for (const n of parsed.neurons ?? []) {
    const rootId = String(n.root_id ?? '');
    const x = Number(n.x);
    const y = Number(n.y);
    const z = Number(n.z);
    if (!rootId || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    out.set(rootId, {
      x,
      y,
      z,
      side: String(n.side ?? ''),
      cell_type: String(n.cell_type ?? ''),
    });
  }
  return out;
}

function parseBaselineTicks(): {
  ticks: ReplayTick[];
  firedIds: Set<string>;
  ringFiredIds: Set<string>;
} {
  const text = fs.readFileSync(INPUT_SPIKES_PATH, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const tickMap = new Map<number, { timeSec: number; spikes: Array<{ rootId: string; order: number }> }>();
  const firedIds = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i] ?? '');
    if (cols.length < 4) continue;
    const tick = Number(cols[0]);
    const timeSec = Number(cols[1]);
    const order = Number(cols[2]);
    const rootId = cols[3] ?? '';
    if (!Number.isFinite(tick) || tick <= 0 || !rootId) continue;
    const bucket = tickMap.get(tick) ?? { timeSec: Number.isFinite(timeSec) ? timeSec : 0, spikes: [] };
    bucket.spikes.push({ rootId, order: Number.isFinite(order) ? order : 0 });
    tickMap.set(tick, bucket);
    firedIds.add(rootId);
  }
  const maxTick = Math.max(1, ...tickMap.keys());
  const ticks: ReplayTick[] = [];
  for (let tick = 1; tick <= maxTick; tick += 1) {
    const bucket = tickMap.get(tick);
    if (!bucket) {
      ticks.push({ tick, time_sec: tick * 0.0001, spikes: [] });
      continue;
    }
    bucket.spikes.sort((a, b) => a.order - b.order);
    ticks.push({
      tick,
      time_sec: bucket.timeSec,
      spikes: bucket.spikes.map((s) => s.rootId),
    });
  }
  return { ticks, firedIds, ringFiredIds: new Set<string>() };
}

function buildReplay(): ReplayData {
  const ringMeta = loadRingMetadata();
  const posMap = loadPositionMap();
  const { ticks, firedIds } = parseBaselineTicks();

  // Include all fired neurons, and force-include the full ring-neuron subset.
  const subsetIds = new Set<string>([...firedIds, ...ringMeta.keys()]);
  const neurons: ReplayNeuron[] = [];
  let missingPositionCount = 0;
  for (const rootId of subsetIds) {
    const pos = posMap.get(rootId);
    if (!pos) {
      missingPositionCount += 1;
      continue;
    }
    const ring = ringMeta.get(rootId);
    neurons.push({
      root_id: rootId,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      is_ring: ring != null,
      side: ring?.side ?? pos.side,
      hemibrain_type: ring?.hemibrain_type ?? '',
    });
  }
  neurons.sort((a, b) => a.root_id.localeCompare(b.root_id));

  const validIds = new Set(neurons.map((n) => n.root_id));
  for (const tick of ticks) {
    tick.spikes = tick.spikes.filter((id) => validIds.has(id));
  }

  const ringFiredIds = new Set<string>();
  for (const tick of ticks) {
    for (const id of tick.spikes) {
      if (ringMeta.has(id)) ringFiredIds.add(id);
    }
  }

  const replay: ReplayData = {
    meta: {
      generated_at: new Date().toISOString(),
      source_csv: INPUT_SPIKES_PATH,
      ticks: ticks.length,
      unique_fired_neurons: firedIds.size,
      ring_neuron_total: ringMeta.size,
      ring_neuron_unique_fired: ringFiredIds.size,
    },
    neurons,
    ticks,
  };

  const summary = [
    'Brain subset preprocessing summary',
    `source_csv: ${INPUT_SPIKES_PATH}`,
    `subset_unique_ids_requested: ${subsetIds.size}`,
    `neurons_with_positions: ${neurons.length}`,
    `missing_positions: ${missingPositionCount}`,
    `ticks: ${replay.meta.ticks}`,
    `ring_neuron_total: ${replay.meta.ring_neuron_total}`,
    `ring_neuron_unique_fired: ${replay.meta.ring_neuron_unique_fired}`,
    `output_json_logs: ${OUT_JSON_LOGS}`,
    `output_json_public: ${OUT_JSON_PUBLIC}`,
  ];
  fs.writeFileSync(OUT_SUMMARY, `${summary.join('\n')}\n`, 'utf8');
  return replay;
}

function main(): void {
  const started = Date.now();
  const replay = buildReplay();
  fs.mkdirSync(path.dirname(OUT_JSON_LOGS), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_SUMMARY), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_JSON_PUBLIC), { recursive: true });
  const serialized = `${JSON.stringify(replay)}\n`;
  fs.writeFileSync(OUT_JSON_LOGS, serialized, 'utf8');
  fs.writeFileSync(OUT_JSON_PUBLIC, serialized, 'utf8');
  const elapsedMs = Date.now() - started;
  fs.appendFileSync(OUT_SUMMARY, `elapsed_ms: ${elapsedMs}\n`, 'utf8');
  console.log(`wrote ${OUT_JSON_LOGS}`);
  console.log(`wrote ${OUT_JSON_PUBLIC}`);
  console.log(`wrote ${OUT_SUMMARY}`);
  console.log(`neurons=${replay.neurons.length} ticks=${replay.ticks.length}`);
}

main();
