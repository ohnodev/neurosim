import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ReplayTick } from '../src/brain-socket-client.js';

type BrainResponse = { error?: string };
type ReplayNeuron = {
  root_id: string;
  x: number;
  y: number;
  z: number;
  processed_label?: string;
  is_ring: boolean;
  is_epg: boolean;
  epg_tile_index_0_7?: number;
  side: string;
  hemibrain_type: string;
  flow?: string;
  super_class?: string;
  class?: string;
  sub_class?: string;
  cell_type?: string;
  hemilineage?: string;
  nerve?: string;
};

type ClassificationRow = {
  root_id: string;
  flow: string;
  super_class: string;
  class: string;
  sub_class: string;
  cell_type: string;
  hemilineage: string;
  side: string;
  nerve: string;
};

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const WORLD_PUBLIC_DIR = path.join(ROOT, 'world', 'public');
const LOGS_DIR = path.join(ROOT, 'logs');
const CLASSIFICATION_PATH = path.join(DATA_DIR, 'raw', 'classification.csv');
const EPG_TILE_MAP_PATH = path.join(DATA_DIR, 'epg-tile-map.json');
const REPLAY_NEURONS_SOURCE = path.join(WORLD_PUBLIC_DIR, 'neurosim_natural_1000tick_replay.json');
const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const REQUEST_TIMEOUT_MS = Number(process.env.NEUROSIM_BRAIN_REQUEST_TIMEOUT_MS ?? 60_000);

const SCENARIO_ID = 'neurosim_epg_aff10_600hz_1000ticks';
const OUT_REPLAY_PATH = path.join(WORLD_PUBLIC_DIR, `${SCENARIO_ID}_replay.json`);
const OUT_TIMELINE_CSV_PATH = path.join(WORLD_PUBLIC_DIR, `${SCENARIO_ID}_timeline.csv`);
const OUT_STIM_AFFERENT_CSV_PATH = path.join(WORLD_PUBLIC_DIR, `${SCENARIO_ID}_stimulated-afferents.csv`);
const OUT_SUMMARY_PATH = path.join(LOGS_DIR, `${SCENARIO_ID}_summary.txt`);

const TICKS = Math.max(1, Number(process.env.NEUROSIM_EPG_EXPORT_TICKS ?? 1000));
const DT_SEC = Number(process.env.NEUROSIM_EPG_EXPORT_DT_SEC ?? 0.0001);
const STIM_RATE_HZ = Math.max(0, Number(process.env.NEUROSIM_EPG_EXPORT_STIM_HZ ?? 600));
const STEP_BATCH = Math.max(1, Number(process.env.NEUROSIM_EPG_EXPORT_STEP_BATCH ?? 10));
const SEED = Number(process.env.NEUROSIM_EPG_EXPORT_SEED ?? 123);

const STIM_AFFERENT_IDS = [
  '720575940626768442',
  '720575940628644239',
  '720575940622303446',
  '720575940623302988',
  '720575940623758377',
  '720575940609713710',
  '720575940612358642',
  '720575940631844300',
  '720575940622416628',
  '720575940632875746',
];

const DRIVER_IDS = [
  '720575940624452902',
  '720575940617672226',
  '720575940640749939',
  '720575940642855328',
  '720575940627264062',
  '720575940612937073',
  '720575940625653223',
  '720575940610980932',
  '720575940619845547',
  '720575940624323475',
];

class BrainSocket {
  private socket: net.Socket;
  private buffer = '';

  private constructor(socket: net.Socket) {
    this.socket = socket;
  }

  static async connect(): Promise<BrainSocket> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(SOCKET_PATH, () => resolve(s));
      s.on('error', reject);
    });
    socket.setNoDelay(true);
    return new BrainSocket(socket);
  }

  close(): void {
    this.socket.destroy();
  }

  async request<T extends BrainResponse>(method: string, params: unknown = {}): Promise<T> {
    const payload = JSON.stringify({ method, params }) + '\n';
    this.socket.write(payload);
    const response = await this.readJsonLine<T>();
    if (response?.error) throw new Error(response.error);
    return response;
  }

  private async readJsonLine<T>(): Promise<T> {
    const timeoutAt = Date.now() + REQUEST_TIMEOUT_MS;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        return JSON.parse(line) as T;
      }
      if (Date.now() > timeoutAt) {
        throw new Error(`brain socket timeout after ${REQUEST_TIMEOUT_MS}ms`);
      }
      const chunk = await new Promise<string>((resolve, reject) => {
        const remaining = timeoutAt - Date.now();
        if (remaining <= 0) {
          reject(new Error(`brain socket timeout after ${REQUEST_TIMEOUT_MS}ms`));
          return;
        }
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`brain socket timeout after ${REQUEST_TIMEOUT_MS}ms`));
        }, remaining);
        const onData = (d: Buffer) => {
          cleanup();
          resolve(d.toString('utf8'));
        };
        const onErr = (e: Error) => {
          cleanup();
          reject(e);
        };
        const onEnd = () => {
          cleanup();
          reject(new Error('brain socket closed'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.socket.off('data', onData);
          this.socket.off('error', onErr);
          this.socket.off('end', onEnd);
        };
        this.socket.on('data', onData);
        this.socket.on('error', onErr);
        this.socket.on('end', onEnd);
      });
      this.buffer += chunk;
    }
  }
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cur = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let seenNonSpace = false;

  const pushField = () => {
    const v = fieldWasQuoted ? cur : cur.trim();
    record.push(v);
    cur = '';
    fieldWasQuoted = false;
    seenNonSpace = false;
  };
  const pushRecord = () => {
    // Skip trailing empty line.
    if (record.length > 1 || (record.length === 1 && record[0].length > 0)) {
      records.push(record);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (!seenNonSpace) {
        inQuotes = true;
        fieldWasQuoted = true;
        continue;
      }
      cur += ch;
      seenNonSpace = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushField();
      pushRecord();
      continue;
    }
    if (ch === '\r') continue;

    if (ch !== ' ' && ch !== '\t') seenNonSpace = true;
    cur += ch;
  }
  pushField();
  pushRecord();
  return records;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function toCsvCell(value: string | number): string {
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function loadClassificationMap(): Map<string, ClassificationRow> {
  const out = new Map<string, ClassificationRow>();
  const text = fs.readFileSync(CLASSIFICATION_PATH, 'utf8');
  const rows = parseCsvRecords(text);
  if (rows.length < 2) return out;
  const header = rows[0] ?? [];
  const idx = {
    root_id: header.indexOf('root_id'),
    flow: header.indexOf('flow'),
    super_class: header.indexOf('super_class'),
    class: header.indexOf('class'),
    sub_class: header.indexOf('sub_class'),
    cell_type: header.indexOf('cell_type'),
    hemilineage: header.indexOf('hemilineage'),
    side: header.indexOf('side'),
    nerve: header.indexOf('nerve'),
  };
  for (let i = 1; i < rows.length; i += 1) {
    const cols = rows[i] ?? [];
    const rootId = idx.root_id >= 0 ? (cols[idx.root_id] ?? '') : '';
    if (!rootId) continue;
    out.set(rootId, {
      root_id: rootId,
      flow: idx.flow >= 0 ? (cols[idx.flow] ?? '') : '',
      super_class: idx.super_class >= 0 ? (cols[idx.super_class] ?? '') : '',
      class: idx.class >= 0 ? (cols[idx.class] ?? '') : '',
      sub_class: idx.sub_class >= 0 ? (cols[idx.sub_class] ?? '') : '',
      cell_type: idx.cell_type >= 0 ? (cols[idx.cell_type] ?? '') : '',
      hemilineage: idx.hemilineage >= 0 ? (cols[idx.hemilineage] ?? '') : '',
      side: idx.side >= 0 ? (cols[idx.side] ?? '') : '',
      nerve: idx.nerve >= 0 ? (cols[idx.nerve] ?? '') : '',
    });
  }
  return out;
}

function buildReplayNeurons(classById: Map<string, ClassificationRow>): ReplayNeuron[] {
  const source = JSON.parse(fs.readFileSync(REPLAY_NEURONS_SOURCE, 'utf8')) as { neurons?: ReplayNeuron[] };
  const epgMap = JSON.parse(fs.readFileSync(EPG_TILE_MAP_PATH, 'utf8')) as {
    entries?: Array<{ root_id?: string; tile_index_0_7?: number }>;
  };
  const tileById = new Map<string, number>();
  for (const e of epgMap.entries ?? []) {
    const id = String(e?.root_id ?? '');
    if (!id) continue;
    if (typeof e?.tile_index_0_7 === 'number') tileById.set(id, e.tile_index_0_7);
  }
  const out: ReplayNeuron[] = [];
  for (const n of source.neurons ?? []) {
    const c = classById.get(n.root_id);
    out.push({
      ...n,
      is_ring: true,
      is_epg: true,
      epg_tile_index_0_7: tileById.get(n.root_id) ?? n.epg_tile_index_0_7,
      flow: c?.flow ?? n.flow,
      super_class: c?.super_class,
      class: c?.class,
      sub_class: c?.sub_class,
      cell_type: c?.cell_type ?? n.cell_type,
      hemilineage: c?.hemilineage,
      side: c?.side ?? n.side,
      nerve: c?.nerve,
    });
  }
  return out;
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const classById = loadClassificationMap();
  const replayNeurons = buildReplayNeurons(classById);
  const epgIdSet = new Set(replayNeurons.map((n) => n.root_id));
  const stimAfferentSet = new Set(STIM_AFFERENT_IDS);
  const driverSet = new Set(DRIVER_IDS);
  const stimProbability = Math.min(1, STIM_RATE_HZ * DT_SEC);
  const rng = createSeededRandom(SEED);

  const conn = await BrainSocket.connect();
  const ticks: ReplayTick[] = [];
  const timelineRows: string[] = [];
  timelineRows.push([
    'tick',
    'time_sec',
    'spike_count_total',
    'epg_spike_count',
    'driver_spike_count',
    'stim_afferent_spike_count',
    'spike_ids',
  ].join(','));

  let overallSpikeEvents = 0;
  const overallUnique = new Set<string>();
  let epgSpikeEvents = 0;
  const epgUnique = new Set<string>();
  let driverSpikeEvents = 0;
  const driverUnique = new Set<string>();
  let stimAfferentSpikeEvents = 0;
  const stimAfferentUnique = new Set<string>();
  let forcedSpikeEvents = 0;

  try {
    await conn.request<{ ok: boolean }>('ping');
    const created = await conn.request<{ sim_id: number }>('create');
    for (let tickStart = 0; tickStart < TICKS; tickStart += STEP_BATCH) {
      const take = Math.min(STEP_BATCH, TICKS - tickStart);
      const steps = Array.from({ length: take }, (_, localIdx) => {
        const i = tickStart + localIdx;
        const forcedSpikes = STIM_AFFERENT_IDS.filter(() => rng() < stimProbability);
        forcedSpikeEvents += forcedSpikes.length;
        return {
          sim_id: created.sim_id,
          dt: DT_SEC,
          include_activity: true,
          olfactory_baseline_rate_hz: 0,
          forced_spikes: forcedSpikes,
          fly: {
            x: 0,
            y: 0,
            z: 0.35,
            heading: 0,
            t: i * DT_SEC,
            hunger: 40,
            health: 100,
            rest_time_left: 0,
            dead: false,
          },
          sources: [],
        };
      });
      const response = await conn.request<{
        results: Array<{ activity_sparse?: Record<string, number> }>;
      }>('step_many', { steps });

      for (let i = 0; i < (response.results ?? []).length; i += 1) {
        const tick = tickStart + i + 1;
        const timeSec = tick * DT_SEC;
        const spikes = Object.keys(response.results[i]?.activity_sparse ?? {}).sort();
        ticks.push({ tick, time_sec: timeSec, spikes });

        overallSpikeEvents += spikes.length;
        let epgTickCount = 0;
        let driverTickCount = 0;
        let stimAfferentTickCount = 0;
        for (const id of spikes) {
          overallUnique.add(id);
          if (epgIdSet.has(id)) {
            epgSpikeEvents += 1;
            epgTickCount += 1;
            epgUnique.add(id);
          }
          if (driverSet.has(id)) {
            driverSpikeEvents += 1;
            driverTickCount += 1;
            driverUnique.add(id);
          }
          if (stimAfferentSet.has(id)) {
            stimAfferentSpikeEvents += 1;
            stimAfferentTickCount += 1;
            stimAfferentUnique.add(id);
          }
        }
        timelineRows.push([
          tick,
          timeSec.toFixed(6),
          spikes.length,
          epgTickCount,
          driverTickCount,
          stimAfferentTickCount,
          toCsvCell(spikes.join('|')),
        ].join(','));
      }
      const done = Math.min(TICKS, tickStart + take);
      if (done % 100 === 0 || done === TICKS) {
        const elapsedMs = Date.now() - startedAt;
        const rate = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0;
        const etaSec = rate > 0 ? Math.max(0, (TICKS - done) / rate) : 0;
        console.log(`[epg-export] progress ${done}/${TICKS} elapsedMs=${elapsedMs} etaSec=${etaSec.toFixed(1)}`);
      }
    }
  } finally {
    conn.close();
  }

  const replay = {
    meta: {
      generated_at: new Date().toISOString(),
      source_csv: OUT_TIMELINE_CSV_PATH,
      ticks: ticks.length,
      unique_fired_neurons: overallUnique.size,
      ring_neuron_total: replayNeurons.length,
      ring_neuron_unique_fired: epgUnique.size,
      dt_sec: DT_SEC,
      epg_neuron_total: replayNeurons.length,
      epg_neuron_unique_fired: epgUnique.size,
      scenario: SCENARIO_ID,
      stimulus: {
        mode: 'forced_poisson_spikes',
        stim_rate_hz: STIM_RATE_HZ,
        dt_sec: DT_SEC,
        seed: SEED,
        stimulated_afferent_ids: STIM_AFFERENT_IDS,
        driver_ids: DRIVER_IDS,
        forced_spike_events: forcedSpikeEvents,
      },
      observed: {
        overall_spike_events: overallSpikeEvents,
        epg_spike_events: epgSpikeEvents,
        driver_spike_events: driverSpikeEvents,
        stim_afferent_spike_events: stimAfferentSpikeEvents,
      },
    },
    neurons: replayNeurons,
    ticks,
  };

  fs.writeFileSync(OUT_REPLAY_PATH, `${JSON.stringify(replay)}\n`, 'utf8');
  fs.writeFileSync(OUT_TIMELINE_CSV_PATH, `${timelineRows.join('\n')}\n`, 'utf8');

  const stimRows = [
    [
      'root_id',
      'flow',
      'super_class',
      'class',
      'sub_class',
      'cell_type',
      'is_olfactory_afferent',
      'notes',
    ].join(','),
  ];
  for (const id of STIM_AFFERENT_IDS) {
    const c = classById.get(id);
    const isOlfactoryAfferent = c?.flow === 'afferent' && c?.class === 'olfactory';
    stimRows.push([
      id,
      toCsvCell(c?.flow ?? ''),
      toCsvCell(c?.super_class ?? ''),
      toCsvCell(c?.class ?? ''),
      toCsvCell(c?.sub_class ?? ''),
      toCsvCell(c?.cell_type ?? ''),
      isOlfactoryAfferent ? 'true' : 'false',
      isOlfactoryAfferent ? 'stimulated afferent in top-10 net-positive set' : 'stimulated but non-olfactory classification',
    ].join(','));
  }
  fs.writeFileSync(OUT_STIM_AFFERENT_CSV_PATH, `${stimRows.join('\n')}\n`, 'utf8');

  const summary = [
    `scenario: ${SCENARIO_ID}`,
    `ticks: ${ticks.length}`,
    `dt_sec: ${DT_SEC}`,
    `stim_rate_hz: ${STIM_RATE_HZ}`,
    `seed: ${SEED}`,
    `stimulated_afferent_count: ${STIM_AFFERENT_IDS.length}`,
    `driver_count: ${DRIVER_IDS.length}`,
    `overall_spike_events: ${overallSpikeEvents}`,
    `overall_unique_fired_neurons: ${overallUnique.size}`,
    `epg_spike_events: ${epgSpikeEvents}`,
    `epg_unique_fired_neurons: ${epgUnique.size}`,
    `driver_spike_events: ${driverSpikeEvents}`,
    `driver_unique_fired_neurons: ${driverUnique.size}`,
    `stim_afferent_spike_events: ${stimAfferentSpikeEvents}`,
    `stim_afferent_unique_fired_neurons: ${stimAfferentUnique.size}`,
    `timeline_csv: ${OUT_TIMELINE_CSV_PATH}`,
    `stim_afferent_csv: ${OUT_STIM_AFFERENT_CSV_PATH}`,
    `frontend_replay_json: ${OUT_REPLAY_PATH}`,
    `elapsed_ms: ${Date.now() - startedAt}`,
  ];
  fs.writeFileSync(OUT_SUMMARY_PATH, `${summary.join('\n')}\n`, 'utf8');
  console.log(summary.join('\n'));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

