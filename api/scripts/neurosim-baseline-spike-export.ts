import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

type ReplayTick = {
  tick: number;
  time_sec: number;
  spikes: string[];
};

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
  cell_type?: string;
};

type ReplayJson = {
  meta: Record<string, unknown>;
  neurons: ReplayNeuron[];
  ticks: ReplayTick[];
};

type BrainResponse = { error?: string };

const ROOT = path.resolve(process.cwd(), '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const REQUEST_TIMEOUT_MS = Number(process.env.NEUROSIM_BRAIN_REQUEST_TIMEOUT_MS ?? 60_000);
const TICKS = Math.max(1, Number(process.env.NEUROSIM_BASELINE_TICKS ?? 1000));
const STEP_BATCH = Math.max(1, Number(process.env.NEUROSIM_BASELINE_STEP_BATCH ?? 50));
const DT_SEC = Number(process.env.NEUROSIM_BASELINE_DT_SEC ?? 0.001);
const OLFACTORY_HZ = Math.max(0, Number(process.env.NEUROSIM_BASELINE_OLFACTORY_HZ ?? 20));
const MECHANO_HZ = Math.max(0, Number(process.env.NEUROSIM_BASELINE_MECHANO_HZ ?? 0));
const THERMO_HZ = Math.max(0, Number(process.env.NEUROSIM_BASELINE_THERMO_HZ ?? 0.5));
const HYGRO_HZ = Math.max(0, Number(process.env.NEUROSIM_BASELINE_HYGRO_HZ ?? 0.5));
const GUSTATORY_HZ = Math.max(0, Number(process.env.NEUROSIM_BASELINE_GUSTATORY_HZ ?? 0));

const CLASSIFICATION_PATH = path.join(ROOT, 'data', 'raw', 'classification.csv');
const OLFACTORY_PATH = path.join(ROOT, 'data', 'olfactory-afferents.json');
const REPLAY_IN_PATH = path.join(ROOT, 'world', 'public', 'neurosim_natural_1000tick_replay.json');
const REPLAY_OUT_PATH = path.join(ROOT, 'world', 'public', 'neurosim_natural_1000tick_replay.json');
const SUMMARY_OUT_PATH = path.join(LOGS_DIR, 'neurosim_baseline_summary.txt');
const RAW_JSON_OUT_PATH = path.join(LOGS_DIR, 'neurosim_baseline_spikes_per_tick.json');

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

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function loadAfferentClassIds(): {
  mechanosensory: string[];
  thermosensory: string[];
  hygrosensory: string[];
  gustatory: string[];
} {
  const out = {
    mechanosensory: [] as string[],
    thermosensory: [] as string[],
    hygrosensory: [] as string[],
    gustatory: [] as string[],
  };
  const text = fs.readFileSync(CLASSIFICATION_PATH, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i] ?? '');
    if (cols.length < 4) continue;
    const rootId = cols[0] ?? '';
    const flow = cols[1] ?? '';
    const superClass = cols[2] ?? '';
    const neuronClass = cols[3] ?? '';
    if (!rootId || flow !== 'afferent' || superClass !== 'sensory') continue;
    if (neuronClass === 'mechanosensory') out.mechanosensory.push(rootId);
    if (neuronClass === 'thermosensory') out.thermosensory.push(rootId);
    if (neuronClass === 'hygrosensory') out.hygrosensory.push(rootId);
    if (neuronClass === 'gustatory') out.gustatory.push(rootId);
  }
  return out;
}

function loadOlfactoryIds(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(OLFACTORY_PATH, 'utf8')) as {
      left?: string[];
      right?: string[];
      unknown?: string[];
    };
    return new Set([...(parsed.left ?? []), ...(parsed.right ?? []), ...(parsed.unknown ?? [])].map(String));
  } catch {
    return new Set<string>();
  }
}

function loadReplayNeurons(): ReplayNeuron[] {
  const parsed = JSON.parse(fs.readFileSync(REPLAY_IN_PATH, 'utf8')) as { neurons?: ReplayNeuron[] };
  return (parsed.neurons ?? []).map((n) => ({ ...n }));
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const neurons = loadReplayNeurons();
  const epgIds = new Set(neurons.map((n) => n.root_id));
  const olfactoryIds = loadOlfactoryIds();
  const afferent = loadAfferentClassIds();
  const rng = createSeededRandom(0x5f43e21d);
  const forcedCounts = {
    mechanosensory: 0,
    thermosensory: 0,
    hygrosensory: 0,
    gustatory: 0,
  };
  const sampleForced = (ids: string[], hz: number): string[] => {
    if (hz <= 0 || ids.length === 0) return [];
    const p = Math.min(1, hz * DT_SEC);
    const out: string[] = [];
    for (const id of ids) {
      if (rng() < p) out.push(id);
    }
    return out;
  };

  const conn = await BrainSocket.connect();
  try {
    await conn.request<{ ok: boolean }>('ping');
    const created = await conn.request<{ sim_id: number }>('create');
    const ticks: ReplayTick[] = [];
    let overallSpikeEvents = 0;
    const overallUnique = new Set<string>();
    let epgSpikeEvents = 0;
    const epgUnique = new Set<string>();
    let olfSpikeEvents = 0;
    const olfUnique = new Set<string>();
    for (let tickStart = 0; tickStart < TICKS; tickStart += STEP_BATCH) {
      const take = Math.min(STEP_BATCH, TICKS - tickStart);
      const steps = Array.from({ length: take }, (_, localIdx) => {
        const i = tickStart + localIdx;
        const forcedMech = sampleForced(afferent.mechanosensory, MECHANO_HZ);
        const forcedThermo = sampleForced(afferent.thermosensory, THERMO_HZ);
        const forcedHygro = sampleForced(afferent.hygrosensory, HYGRO_HZ);
        const forcedGust = sampleForced(afferent.gustatory, GUSTATORY_HZ);
        forcedCounts.mechanosensory += forcedMech.length;
        forcedCounts.thermosensory += forcedThermo.length;
        forcedCounts.hygrosensory += forcedHygro.length;
        forcedCounts.gustatory += forcedGust.length;
        const forced = [...forcedMech, ...forcedThermo, ...forcedHygro, ...forcedGust];
        return {
          sim_id: created.sim_id,
          dt: DT_SEC,
          include_activity: true,
          olfactory_baseline_rate_hz: OLFACTORY_HZ,
          forced_spikes: forced,
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
        const globalTick = tickStart + i + 1;
        const spikes = Object.keys(response.results[i]?.activity_sparse ?? {}).sort();
        ticks.push({ tick: globalTick, time_sec: globalTick * DT_SEC, spikes });
        overallSpikeEvents += spikes.length;
        for (const id of spikes) {
          overallUnique.add(id);
          if (epgIds.has(id)) {
            epgSpikeEvents += 1;
            epgUnique.add(id);
          }
          if (olfactoryIds.has(id)) {
            olfSpikeEvents += 1;
            olfUnique.add(id);
          }
        }
      }
    }

    const replay: ReplayJson = {
      meta: {
        generated_at: new Date().toISOString(),
        source_csv: 'api:/brain-socket step_many',
        ticks: ticks.length,
        unique_fired_neurons: overallUnique.size,
        ring_neuron_total: neurons.length,
        ring_neuron_unique_fired: epgUnique.size,
        dt_sec: DT_SEC,
        epg_neuron_total: neurons.length,
        epg_neuron_unique_fired: epgUnique.size,
        scenario: 'neurosim_natural_20hz_1000ticks',
        baseline: {
          olfactoryBaselineHz: OLFACTORY_HZ,
          mechanoHz: MECHANO_HZ,
          thermoHz: THERMO_HZ,
          hygroHz: HYGRO_HZ,
          gustatoryHz: GUSTATORY_HZ,
          olfactory_afferent_pool_size: olfactoryIds.size,
          afferent_pool_sizes: {
            mechanosensory: afferent.mechanosensory.length,
            thermosensory: afferent.thermosensory.length,
            hygrosensory: afferent.hygrosensory.length,
            gustatory: afferent.gustatory.length,
          },
          forced_spike_events: forcedCounts,
          observed_spikes: {
            overall_spike_events: overallSpikeEvents,
            overall_unique_fired_neurons: overallUnique.size,
            olfactory_spike_events: olfSpikeEvents,
            olfactory_unique_fired_neurons: olfUnique.size,
            epg_spike_events: epgSpikeEvents,
            epg_unique_fired_neurons: epgUnique.size,
          },
        },
      },
      neurons,
      ticks,
    };

    fs.writeFileSync(RAW_JSON_OUT_PATH, `${JSON.stringify(replay, null, 2)}\n`, 'utf8');
    fs.writeFileSync(REPLAY_OUT_PATH, `${JSON.stringify(replay)}\n`, 'utf8');
    const summary = [
      'NeuroSim baseline export summary',
      `ticks: ${TICKS}`,
      `dt_sec: ${DT_SEC}`,
      `olfactory_hz: ${OLFACTORY_HZ}`,
      `mechano_hz: ${MECHANO_HZ}`,
      `thermo_hz: ${THERMO_HZ}`,
      `hygro_hz: ${HYGRO_HZ}`,
      `gustatory_hz: ${GUSTATORY_HZ}`,
      `olfactory_pool_size: ${olfactoryIds.size}`,
      `overall_spike_events: ${overallSpikeEvents}`,
      `overall_unique_fired_neurons: ${overallUnique.size}`,
      `epg_spike_events: ${epgSpikeEvents}`,
      `epg_unique_fired_neurons: ${epgUnique.size}`,
      `olfactory_spike_events: ${olfSpikeEvents}`,
      `olfactory_unique_fired_neurons: ${olfUnique.size}`,
      `forced_spike_events: ${JSON.stringify(forcedCounts)}`,
      `frontend_replay_path: ${REPLAY_OUT_PATH}`,
      `raw_json_path: ${RAW_JSON_OUT_PATH}`,
      `elapsed_ms: ${Date.now() - startedAt}`,
    ];
    fs.writeFileSync(SUMMARY_OUT_PATH, `${summary.join('\n')}\n`, 'utf8');
    console.log(summary.join('\n'));
  } finally {
    conn.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

