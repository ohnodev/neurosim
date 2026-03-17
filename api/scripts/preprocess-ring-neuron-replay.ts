import * as fs from 'node:fs';
import * as path from 'node:path';

type RingNeuronMeta = {
  rootId: string;
  hemibrainType: string;
  side: string;
  ringIndex: number;
  angleDeg: number;
};

type SpikeRow = {
  tick: number;
  timeSec: number;
  spikeOrder: number;
  rootId: string;
};

const ROOT = path.resolve(process.cwd(), '..');
const CLASSIFICATION_PATH = path.join(ROOT, 'data', 'raw', 'classification.csv');
const BASELINE_SPIKES_PATH = path.join(ROOT, 'logs', 'eonsystems_baseline_spikes_per_tick.csv');
const OUT_CSV_PATH = path.join(ROOT, 'logs', 'eonsystems_ring_neurons_spikes_per_tick.csv');
const OUT_SUMMARY_PATH = path.join(ROOT, 'logs', 'eonsystems_ring_neurons_summary.txt');

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

function loadRingNeuronsFromClassification(): Map<string, RingNeuronMeta> {
  const text = fs.readFileSync(CLASSIFICATION_PATH, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const ringCandidates: Array<{ rootId: string; hemibrainType: string; side: string }> = [];
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
    const isRingNeuron = subClass === 'ring_neuron';
    if (!isRingNeuron) continue;
    if (!rootId) continue;
    // Keep expected family scope from the user example.
    if (flow !== 'intrinsic' || superClass !== 'central' || neuronClass !== 'CX') continue;
    ringCandidates.push({ rootId, hemibrainType, side });
  }
  ringCandidates.sort((a, b) => {
    if (a.hemibrainType !== b.hemibrainType) return a.hemibrainType.localeCompare(b.hemibrainType);
    if (a.side !== b.side) return a.side.localeCompare(b.side);
    return a.rootId.localeCompare(b.rootId);
  });
  const out = new Map<string, RingNeuronMeta>();
  const n = Math.max(1, ringCandidates.length);
  for (let i = 0; i < ringCandidates.length; i += 1) {
    const neuron = ringCandidates[i]!;
    const angleDeg = (i / n) * 360.0;
    out.set(neuron.rootId, {
      rootId: neuron.rootId,
      hemibrainType: neuron.hemibrainType,
      side: neuron.side,
      ringIndex: i,
      angleDeg,
    });
  }
  return out;
}

function loadRingSpikes(ringMeta: Map<string, RingNeuronMeta>): SpikeRow[] {
  const text = fs.readFileSync(BASELINE_SPIKES_PATH, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const out: SpikeRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i] ?? '');
    if (cols.length < 4) continue;
    const tick = Number(cols[0]);
    const timeSec = Number(cols[1]);
    const spikeOrder = Number(cols[2]);
    const rootId = cols[3] ?? '';
    if (!Number.isFinite(tick) || !Number.isFinite(timeSec) || !Number.isFinite(spikeOrder)) continue;
    if (!ringMeta.has(rootId)) continue;
    out.push({ tick, timeSec, spikeOrder, rootId });
  }
  out.sort((a, b) => (a.tick - b.tick) || (a.spikeOrder - b.spikeOrder) || a.rootId.localeCompare(b.rootId));
  return out;
}

function writeRingReplayCsv(ringMeta: Map<string, RingNeuronMeta>, spikes: SpikeRow[]): void {
  const lines: string[] = [];
  lines.push('tick,time_sec,spike_order,is_active,root_id,ring_index,angle_deg,hemibrain_type,side');
  // Bootstrap rows (tick 0) encode the full ring layout so renderer can always draw all 278.
  for (const meta of [...ringMeta.values()].sort((a, b) => a.ringIndex - b.ringIndex)) {
    lines.push([
      '0',
      '0.000000',
      '-1',
      '0',
      meta.rootId,
      String(meta.ringIndex),
      meta.angleDeg.toFixed(6),
      meta.hemibrainType,
      meta.side,
    ].join(','));
  }
  for (const spike of spikes) {
    const meta = ringMeta.get(spike.rootId);
    if (!meta) continue;
    lines.push([
      String(spike.tick),
      spike.timeSec.toFixed(6),
      String(spike.spikeOrder),
      '1',
      spike.rootId,
      String(meta.ringIndex),
      meta.angleDeg.toFixed(6),
      meta.hemibrainType,
      meta.side,
    ].join(','));
  }
  fs.writeFileSync(OUT_CSV_PATH, `${lines.join('\n')}\n`, 'utf8');
}

function writeSummary(ringMeta: Map<string, RingNeuronMeta>, spikes: SpikeRow[], elapsedMs: number): void {
  const uniqueFired = new Set(spikes.map((s) => s.rootId));
  const firstTick = spikes.length > 0 ? spikes[0]!.tick : -1;
  const lastTick = spikes.length > 0 ? spikes[spikes.length - 1]!.tick : -1;
  const summary = [
    'Ring neuron preprocessing summary',
    `ring_neuron_total: ${ringMeta.size}`,
    `ring_neuron_unique_fired: ${uniqueFired.size}`,
    `ring_spike_events: ${spikes.length}`,
    `first_ring_tick: ${firstTick}`,
    `last_ring_tick: ${lastTick}`,
    `source_csv: ${BASELINE_SPIKES_PATH}`,
    `output_csv: ${OUT_CSV_PATH}`,
    `elapsed_ms: ${elapsedMs}`,
  ];
  fs.writeFileSync(OUT_SUMMARY_PATH, `${summary.join('\n')}\n`, 'utf8');
}

async function main(): Promise<void> {
  const started = Date.now();
  const ringMeta = loadRingNeuronsFromClassification();
  const spikes = loadRingSpikes(ringMeta);
  writeRingReplayCsv(ringMeta, spikes);
  writeSummary(ringMeta, spikes, Date.now() - started);
  console.log(`wrote ${OUT_CSV_PATH}`);
  console.log(`wrote ${OUT_SUMMARY_PATH}`);
  console.log(`ring_neuron_total=${ringMeta.size}`);
  console.log(`ring_neuron_unique_fired=${new Set(spikes.map((s) => s.rootId)).size}`);
  console.log(`ring_spike_events=${spikes.length}`);
}

main()
  .catch((err) => {
    console.error(
      `[preprocess-ring-neuron-replay] failed (csv=${OUT_CSV_PATH}, summary=${OUT_SUMMARY_PATH}):`,
      err,
    );
    process.exit(1);
  });
