import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

type ClassificationRow = {
  root_id: string;
  flow: string;
  super_class: string;
  class: string;
  sub_class: string;
  cell_type: string;
  hemibrain_type: string;
  hemilineage: string;
  side: string;
  nerve: string;
};

type ReplayTick = {
  tick: number;
  time_sec: number;
  spikes: string[];
};

type ReplayJson = {
  meta: {
    ticks: number;
    dt_sec: number;
    baseline_rate_hz: number;
    generated_at: string;
  };
  ticks: ReplayTick[];
};

const ROOT = path.resolve(process.cwd(), '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const CLASSIFICATION_PATH = path.join(ROOT, 'data', 'raw', 'classification.csv');
const OUT_CSV = path.join(LOGS_DIR, 'eonsystems_baseline_spikes_per_tick.csv');
const OUT_JSON = path.join(LOGS_DIR, 'eonsystems_baseline_spikes_per_tick.json');
const OUT_SUMMARY = path.join(LOGS_DIR, 'eonsystems_baseline_summary.txt');

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const REQUEST_TIMEOUT_MS = Number(process.env.NEUROSIM_BRAIN_REQUEST_TIMEOUT_MS ?? 30_000);
const TICKS = Math.max(1, Number(process.env.BASELINE_TICKS ?? 3000));
const DT_SEC = Number(process.env.BASELINE_DT_SEC ?? 0.0001);
const BASELINE_RATE_HZ = Math.max(0, Number(process.env.BASELINE_OLFACTORY_HZ ?? 2));
const HYGRO_BASELINE_HZ = Math.max(0, Number(process.env.BASELINE_HYGRO_HZ ?? 6));
const THERMO_BASELINE_HZ = Math.max(0, Number(process.env.BASELINE_THERMO_HZ ?? 6));

type BrainResponse = { error?: string };

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

function loadClassificationMap(): Map<string, ClassificationRow> {
  const txt = fs.readFileSync(CLASSIFICATION_PATH, 'utf8');
  const lines = txt.split('\n').filter((l) => l.trim().length > 0);
  const map = new Map<string, ClassificationRow>();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 10) continue;
    const row: ClassificationRow = {
      root_id: cols[0],
      flow: cols[1],
      super_class: cols[2],
      class: cols[3],
      sub_class: cols[4],
      cell_type: cols[5],
      hemibrain_type: cols[6],
      hemilineage: cols[7],
      side: cols[8],
      nerve: cols[9],
    };
    map.set(row.root_id, row);
  }
  return map;
}

async function runBaselineReplay(): Promise<ReplayJson> {
  const conn = await BrainSocket.connect();
  try {
    await conn.request<{ ok: boolean }>('ping');
    const created = await conn.request<{ sim_id: number }>('create');
    const simId = created.sim_id;
    const steps = Array.from({ length: TICKS }, (_, i) => ({
      sim_id: simId,
      dt: DT_SEC,
      include_activity: true,
      olfactory_baseline_rate_hz: BASELINE_RATE_HZ,
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
      pending: [],
    }));
    const response = await conn.request<{
      results: Array<{ activity_sparse?: Record<string, number> }>;
    }>('step_many', { steps });
    const ticks: ReplayTick[] = (response.results ?? []).map((item, idx) => {
      const spikes = Object.keys(item.activity_sparse ?? {}).sort();
      return {
        tick: idx + 1,
        time_sec: (idx + 1) * DT_SEC,
        spikes,
      };
    });
    return {
      meta: {
        ticks: ticks.length,
        dt_sec: DT_SEC,
        baseline_rate_hz: BASELINE_RATE_HZ,
        generated_at: new Date().toISOString(),
      },
      ticks,
    };
  } finally {
    conn.close();
  }
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function augmentTicksWithSensoryBaseline(
  replay: ReplayJson,
  hygroIds: string[],
  thermoIds: string[],
): { hygroAdded: number; thermoAdded: number } {
  let hygroAdded = 0;
  let thermoAdded = 0;
  const rng = createSeededRandom(0x51f15e27);
  const addGroup = (ids: string[], hz: number, tick: ReplayTick): number => {
    if (hz <= 0 || ids.length === 0) return 0;
    const p = Math.min(1, hz * replay.meta.dt_sec);
    let added = 0;
    for (const id of ids) {
      if (rng() < p) {
        tick.spikes.push(id);
        added += 1;
      }
    }
    return added;
  };
  for (const tick of replay.ticks) {
    hygroAdded += addGroup(hygroIds, HYGRO_BASELINE_HZ, tick);
    thermoAdded += addGroup(thermoIds, THERMO_BASELINE_HZ, tick);
  }
  for (const tick of replay.ticks) {
    tick.spikes.sort();
  }
  return { hygroAdded, thermoAdded };
}

function writeOutputs(
  replay: ReplayJson,
  cls: Map<string, ClassificationRow>,
  elapsedMs: number,
  hygroAdded: number,
  thermoAdded: number,
): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(replay, null, 2)}\n`, 'utf8');

  const csvLines = [
    [
      'tick',
      'time_sec',
      'spike_order',
      'root_id',
      'flow',
      'super_class',
      'class',
      'sub_class',
      'cell_type',
      'hemibrain_type',
      'hemilineage',
      'side',
      'nerve',
    ].join(','),
  ];
  let totalSpikes = 0;
  let firstActiveTick = -1;
  let lastActiveTick = -1;
  for (const tick of replay.ticks) {
    if (tick.spikes.length > 0) {
      if (firstActiveTick === -1) firstActiveTick = tick.tick;
      lastActiveTick = tick.tick;
    }
    totalSpikes += tick.spikes.length;
    for (let i = 0; i < tick.spikes.length; i += 1) {
      const rootId = tick.spikes[i]!;
      const meta = cls.get(rootId);
      csvLines.push([
        String(tick.tick),
        tick.time_sec.toFixed(6),
        String(i),
        rootId,
        meta?.flow ?? '',
        meta?.super_class ?? '',
        meta?.class ?? '',
        meta?.sub_class ?? '',
        meta?.cell_type ?? '',
        meta?.hemibrain_type ?? '',
        meta?.hemilineage ?? '',
        meta?.side ?? '',
        meta?.nerve ?? '',
      ].join(','));
    }
  }
  fs.writeFileSync(OUT_CSV, `${csvLines.join('\n')}\n`, 'utf8');

  const summary = [
    'EonSystems baseline replay summary',
    `ticks: ${replay.meta.ticks}`,
    `dt_sec: ${replay.meta.dt_sec}`,
    `baseline_rate_hz: ${replay.meta.baseline_rate_hz}`,
    `hygro_baseline_hz: ${HYGRO_BASELINE_HZ}`,
    `thermo_baseline_hz: ${THERMO_BASELINE_HZ}`,
    `hygro_spikes_added: ${hygroAdded}`,
    `thermo_spikes_added: ${thermoAdded}`,
    `total_spikes: ${totalSpikes}`,
    `first_active_tick: ${firstActiveTick}`,
    `last_active_tick: ${lastActiveTick}`,
    `elapsed_ms: ${elapsedMs}`,
    `json_path: ${OUT_JSON}`,
    `csv_path: ${OUT_CSV}`,
  ];
  fs.writeFileSync(OUT_SUMMARY, `${summary.join('\n')}\n`, 'utf8');
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const cls = loadClassificationMap();
  const replay = await runBaselineReplay();
  const hygroIds = [...cls.values()]
    .filter((r) => r.flow === 'afferent' && r.super_class === 'sensory' && r.class === 'hygrosensory')
    .map((r) => r.root_id);
  const thermoIds = [...cls.values()]
    .filter((r) => r.flow === 'afferent' && r.super_class === 'sensory' && r.class === 'thermosensory')
    .map((r) => r.root_id);
  const { hygroAdded, thermoAdded } = augmentTicksWithSensoryBaseline(replay, hygroIds, thermoIds);
  const elapsedMs = Date.now() - startedAt;
  writeOutputs(replay, cls, elapsedMs, hygroAdded, thermoAdded);
  console.log(`wrote ${OUT_JSON}`);
  console.log(`wrote ${OUT_CSV}`);
  console.log(`wrote ${OUT_SUMMARY}`);
  console.log(`elapsed_ms: ${elapsedMs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
