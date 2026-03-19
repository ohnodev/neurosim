/**
 * EPG compass neuron list + ring positions matching VisualizationPage layout.
 * Fetches replay + processed_labels and builds the same ring used on the Visualization page.
 */

const EPG_COMPASS_BINS = 16;
const EPG_SLICE_ORDER_CLOCKWISE = [
  'L5', 'R4', 'L6', 'R3', 'L7', 'R2', 'L8', 'R1',
  'L1', 'R8', 'L2', 'R7', 'L3', 'R6', 'L4', 'R5',
];
const EPG_LABEL_TO_BIN = new Map(EPG_SLICE_ORDER_CLOCKWISE.map((label, i) => [label, i]));
const COMPASS_ROTATION_RAD = Math.PI / 2;

/** Same as VisualizationPage: scene angle for bin (clockwise, bin 0 at top). */
export function sceneAngleForBin(bin: number, binCount: number): number {
  return COMPASS_ROTATION_RAD - (bin / binCount) * Math.PI * 2;
}

export { EPG_COMPASS_BINS, EPG_SLICE_ORDER_CLOCKWISE };

type ReplayNeuronMinimal = {
  root_id: string;
  is_epg?: boolean;
  side?: string;
  hemibrain_type?: string;
  processed_label?: string;
  epg_tile_index_0_7?: number;
  hemilineage?: string;
  flow?: string;
  super_class?: string;
  class?: string;
  sub_class?: string;
  cell_type?: string;
  nerve?: string;
};

export type CompassEpgNeuron = {
  root_id: string;
  bin: number;
  binLabel: string;
  side: string;
  hemibrain_type: string;
  hemilineage: string;
  flow: string;
  super_class: string;
  class: string;
  sub_class: string;
  cell_type: string;
  nerve: string;
};

function parseProcessedLabelsLine(line: string): [string, string] | null {
  const t = line.trim();
  if (!t) return null;
  const cols: string[] = [];
  let i = 0;
  while (i < t.length && cols.length < 2) {
    if (t[i] === '"') {
      i += 1;
      let field = '';
      while (i < t.length) {
        if (t[i] === '"') {
          i += 1;
          if (i < t.length && t[i] === '"') {
            field += '"';
            i += 1;
          } else break;
        } else {
          field += t[i];
          i += 1;
        }
      }
      cols.push(field);
      if (i < t.length && t[i] === ',') i += 1;
    } else {
      const comma = t.indexOf(',', i);
      const field = (comma >= 0 ? t.slice(i, comma) : t.slice(i)).trim();
      cols.push(field);
      i = comma >= 0 ? comma + 1 : t.length;
    }
  }
  if (cols.length >= 2) return [cols[0].trim(), cols[1].trim()];
  if (cols.length === 1) return [cols[0].trim(), ''];
  return null;
}

function getEffectiveEpgLabel(
  neuron: ReplayNeuronMinimal,
  processedLabelMap: Map<string, string> | null,
): string | undefined {
  const fromMap = processedLabelMap?.get(neuron.root_id);
  if (fromMap && EPG_LABEL_TO_BIN.has(fromMap)) return fromMap;
  const side = (neuron.side ?? '').trim().toLowerCase();
  const tile = neuron.epg_tile_index_0_7;
  if ((side === 'left' || side === 'right') && typeof tile === 'number') {
    const label = `${side === 'left' ? 'L' : 'R'}${tile + 1}`;
    if (EPG_LABEL_TO_BIN.has(label)) return label;
  }
  const parsed = (neuron.processed_label ?? '').toUpperCase().replace(/[^LR0-9]/g, '');
  return EPG_LABEL_TO_BIN.has(parsed) ? parsed : undefined;
}

function getEffectiveEpgTile(
  neuron: ReplayNeuronMinimal,
  processedLabelMap: Map<string, string> | null,
): number | undefined {
  const label = getEffectiveEpgLabel(neuron, processedLabelMap);
  if (!label) return undefined;
  return EPG_LABEL_TO_BIN.get(label);
}

function isCompassEpgNeuron(neuron: ReplayNeuronMinimal): boolean {
  if (!neuron.is_epg) return false;
  const hb = (neuron.hemibrain_type ?? '').trim().toUpperCase();
  return hb !== 'EPGT';
}

const REPLAY_URL = '/neurosim_rust_pen_L100_R0_B0_100k_rec3p5x_seed17290319_replay.json';
const PROCESSED_LABELS_URL = '/processed_labels.csv';

let cached: { neurons: CompassEpgNeuron[]; positions: Float32Array } | null = null;

export async function fetchCompassEpgData(): Promise<{
  neurons: CompassEpgNeuron[];
  positions: Float32Array;
}> {
  if (cached) return cached;

  const [replayRes, labelsRes] = await Promise.all([
    fetch(REPLAY_URL, { cache: 'default' }),
    fetch(PROCESSED_LABELS_URL + '?v=' + Date.now(), { cache: 'no-store' }),
  ]);
  if (!replayRes.ok || !labelsRes.ok) {
    throw new Error('Failed to load compass EPG data');
  }
  const replay = (await replayRes.json()) as { neurons: ReplayNeuronMinimal[] };
  const labelsText = await labelsRes.text();
  const epgLabelMap = new Map<string, string>();
  for (const line of labelsText.split('\n')) {
    const row = parseProcessedLabelsLine(line);
    if (row) {
      const [rid, label] = row;
      if (rid && EPG_LABEL_TO_BIN.has(label)) epgLabelMap.set(rid, label);
    }
  }

  const allNeurons = replay.neurons ?? [];
  const epgIndices: number[] = [];
  for (let i = 0; i < allNeurons.length; i++) {
    if (allNeurons[i] && isCompassEpgNeuron(allNeurons[i]!)) epgIndices.push(i);
  }

  const tileGroups = new Map<number, number[]>();
  const unassigned: number[] = [];
  for (const idx of epgIndices) {
    const neuron = allNeurons[idx]!;
    const tile = getEffectiveEpgTile(neuron, epgLabelMap);
    if (tile == null || tile < 0 || tile >= EPG_COMPASS_BINS) {
      unassigned.push(idx);
      continue;
    }
    const group = tileGroups.get(tile) ?? [];
    group.push(idx);
    tileGroups.set(tile, group);
  }

  const baseRadius = 0.5;
  const scale = 1.5;
  const cx = 0;
  const cy = 0;
  const cz = 0;
  const sector = (Math.PI * 2) / EPG_COMPASS_BINS;
  const spread = sector * 0.35;

  const orderedIndices: number[] = [];
  const binByIndex: number[] = [];
  const labelByIndex: string[] = [];
  const angleByIndex: number[] = [];

  for (const [tile, indices] of tileGroups.entries()) {
    indices.sort((a, b) => (allNeurons[a]?.root_id ?? '').localeCompare(allNeurons[b]?.root_id ?? ''));
    const angleCenter = sceneAngleForBin(tile, EPG_COMPASS_BINS);
    for (let k = 0; k < indices.length; k++) {
      const idx = indices[k]!;
      const centered = indices.length > 1 ? (k / (indices.length - 1)) - 0.5 : 0;
      const angle = angleCenter + centered * spread;
      orderedIndices.push(idx);
      binByIndex.push(tile);
      labelByIndex.push(EPG_SLICE_ORDER_CLOCKWISE[tile] ?? '');
      angleByIndex.push(angle);
    }
  }
  for (let k = 0; k < unassigned.length; k++) {
    const idx = unassigned[k]!;
    const bin = k % EPG_COMPASS_BINS;
    orderedIndices.push(idx);
    binByIndex.push(bin);
    labelByIndex.push(EPG_SLICE_ORDER_CLOCKWISE[bin] ?? '');
    angleByIndex.push(sceneAngleForBin(bin, EPG_COMPASS_BINS));
  }

  const n = orderedIndices.length;
  const positions = new Float32Array(n * 3);
  const neurons: CompassEpgNeuron[] = [];

  for (let i = 0; i < n; i++) {
    const idx = orderedIndices[i]!;
    const neuron = allNeurons[idx]!;
    const angle = angleByIndex[i]!;
    const px = cx + Math.cos(angle) * baseRadius;
    const py = cy + Math.sin(angle) * baseRadius;
    const pz = cz;
    positions[i * 3] = (px - cx) / scale;
    positions[i * 3 + 1] = (py - cy) / scale;
    positions[i * 3 + 2] = (pz - cz) / scale;
    neurons.push({
      root_id: neuron.root_id,
      bin: binByIndex[i]!,
      binLabel: labelByIndex[i]!,
      side: neuron.side ?? '',
      hemibrain_type: neuron.hemibrain_type ?? '',
      hemilineage: neuron.hemilineage ?? '',
      flow: neuron.flow ?? '',
      super_class: neuron.super_class ?? '',
      class: neuron.class ?? '',
      sub_class: neuron.sub_class ?? '',
      cell_type: neuron.cell_type ?? '',
      nerve: neuron.nerve ?? '',
    });
  }

  cached = { neurons, positions };
  return cached;
}
