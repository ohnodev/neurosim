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
    scenario: string;
    generated_at: string;
  };
  ticks: ReplayTick[];
};

const ROOT = path.resolve(process.cwd(), '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const CLASSIFICATION_PATH = path.join(ROOT, 'data', 'raw', 'classification.csv');
const OUT_CSV = path.join(LOGS_DIR, 'eonsystems_left_bias_spikes_per_tick.csv');
const OUT_JSON = path.join(LOGS_DIR, 'eonsystems_left_bias_spikes_per_tick.json');
const OUT_SUMMARY = path.join(LOGS_DIR, 'eonsystems_left_bias_summary.txt');

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const REQUEST_TIMEOUT_MS = Number(process.env.NEUROSIM_BRAIN_REQUEST_TIMEOUT_MS ?? 30_000);
const TICKS = Math.max(1, Number(process.env.LEFT_BIAS_TICKS ?? 3000));
const DT_SEC = Number(process.env.LEFT_BIAS_DT_SEC ?? 0.0001);
const BASELINE_RATE_HZ = Math.max(0, Number(process.env.LEFT_BIAS_BASELINE_OLFACTORY_HZ ?? 2));
const LEFT_SOURCES = [
  { id: 'odor-left-near', x: -10, y: 0, radius: 3.2 },
  { id: 'odor-left-mid', x: -16, y: 4, radius: 3.2 },
  { id: 'odor-left-far', x: -22, y: -6, radius: 3.2 },
];

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
    const cols = parseCsvLine(lines[i] ?? '');
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

async function runLeftBiasReplay(): Promise<ReplayJson> {
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
      // Left-side odor gradient using multiple odor points.
      sources: LEFT_SOURCES,
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
        scenario: 'left_bias_odor_gradient',
        generated_at: new Date().toISOString(),
      },
      ticks,
    };
  } finally {
    conn.close();
  }
}

function writeOutputs(replay: ReplayJson, cls: Map<string, ClassificationRow>, elapsedMs: number): void {
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

  const leftOlfactory = [...cls.values()].filter(
    (r) => r.class === 'olfactory' && r.side === 'left' && r.flow === 'afferent',
  ).length;
  const rightOlfactory = [...cls.values()].filter(
    (r) => r.class === 'olfactory' && r.side === 'right' && r.flow === 'afferent',
  ).length;

  const summary = [
    'EonSystems left-bias odor replay summary',
    `scenario: ${replay.meta.scenario}`,
    `ticks: ${replay.meta.ticks}`,
    `dt_sec: ${replay.meta.dt_sec}`,
    `baseline_rate_hz: ${replay.meta.baseline_rate_hz}`,
    `left_sources: ${JSON.stringify(LEFT_SOURCES)}`,
    `selected_olfactory_group_left_count: ${leftOlfactory}`,
    `selected_olfactory_group_right_count: ${rightOlfactory}`,
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
  const replay = await runLeftBiasReplay();
  const elapsedMs = Date.now() - startedAt;
  writeOutputs(replay, cls, elapsedMs);
  console.log(`wrote ${OUT_JSON}`);
  console.log(`wrote ${OUT_CSV}`);
  console.log(`wrote ${OUT_SUMMARY}`);
  console.log(`elapsed_ms: ${elapsedMs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
