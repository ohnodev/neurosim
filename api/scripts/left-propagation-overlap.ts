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

type FiredStats = {
  spikeCount: number;
  firstTick: number;
  lastTick: number;
};

const ROOT = path.resolve(process.cwd(), '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const CLASSIFICATION_PATH = path.join(ROOT, 'data', 'raw', 'classification.csv');
const EONSYSTEMS_NEURONS_PATH = path.join(LOGS_DIR, 'eonsystems_left_propagation_neurons.csv');

const NEUROSIM_NEURONS_PATH = path.join(LOGS_DIR, 'neurosim_left_propagation_neurons.csv');
const NEUROSIM_SUMMARY_PATH = path.join(LOGS_DIR, 'neurosim_left_propagation_summary.txt');
const OVERLAP_PATH = path.join(LOGS_DIR, 'neurosim_eonsystems_overlap.csv');
const OVERLAP_SUMMARY_PATH = path.join(LOGS_DIR, 'neurosim_eonsystems_overlap_summary.txt');

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const REQUEST_TIMEOUT_MS = Number(process.env.NEUROSIM_BRAIN_REQUEST_TIMEOUT_MS ?? 20_000);
const TICKS = Math.max(1, Number(process.env.PROP_TICKS ?? 300));
const DT = Number(process.env.PROP_DT ?? 0.0001);
const SOURCE = { id: 'left', x: 0, y: 12, radius: 3.2 };

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

function writeNeurosimCsv(stats: Map<string, FiredStats>, cls: Map<string, ClassificationRow>): void {
  const rows = [...stats.entries()].map(([rootId, s]) => {
    const c = cls.get(rootId);
    return {
      root_id: rootId,
      spike_count: s.spikeCount,
      first_tick: s.firstTick,
      last_tick: s.lastTick,
      tick_span: s.lastTick - s.firstTick + 1,
      flow: c?.flow ?? '',
      super_class: c?.super_class ?? '',
      class: c?.class ?? '',
      sub_class: c?.sub_class ?? '',
      cell_type: c?.cell_type ?? '',
      hemibrain_type: c?.hemibrain_type ?? '',
      hemilineage: c?.hemilineage ?? '',
      side: c?.side ?? '',
      nerve: c?.nerve ?? '',
    };
  });
  rows.sort((a, b) => (a.first_tick - b.first_tick) || (b.spike_count - a.spike_count));
  const header = [
    'root_id', 'spike_count', 'first_tick', 'last_tick', 'tick_span',
    'flow', 'super_class', 'class', 'sub_class', 'cell_type',
    'hemibrain_type', 'hemilineage', 'side', 'nerve',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.root_id, r.spike_count, r.first_tick, r.last_tick, r.tick_span,
      r.flow, r.super_class, r.class, r.sub_class, r.cell_type,
      r.hemibrain_type, r.hemilineage, r.side, r.nerve,
    ].join(','));
  }
  fs.writeFileSync(NEUROSIM_NEURONS_PATH, `${lines.join('\n')}\n`, 'utf8');
}

function readCsvRootIds(filePath: string): Set<string> {
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split('\n').filter((l) => l.trim().length > 0);
  const out = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    if (cols[0]) out.add(cols[0]);
  }
  return out;
}

function writeOverlapCsv(
  overlap: string[],
  neuroStats: Map<string, FiredStats>,
  cls: Map<string, ClassificationRow>,
): void {
  const header = [
    'root_id', 'neurosim_spike_count', 'neurosim_first_tick', 'neurosim_last_tick',
    'flow', 'super_class', 'class', 'sub_class', 'cell_type', 'hemibrain_type',
    'hemilineage', 'side', 'nerve',
  ];
  const rows = overlap.map((rid) => {
    const s = neuroStats.get(rid);
    const c = cls.get(rid);
    return [
      rid,
      String(s?.spikeCount ?? 0),
      String(s?.firstTick ?? ''),
      String(s?.lastTick ?? ''),
      c?.flow ?? '',
      c?.super_class ?? '',
      c?.class ?? '',
      c?.sub_class ?? '',
      c?.cell_type ?? '',
      c?.hemibrain_type ?? '',
      c?.hemilineage ?? '',
      c?.side ?? '',
      c?.nerve ?? '',
    ].join(',');
  });
  fs.writeFileSync(OVERLAP_PATH, `${[header.join(','), ...rows].join('\n')}\n`, 'utf8');
}

async function main(): Promise<void> {
  if (!fs.existsSync(EONSYSTEMS_NEURONS_PATH)) {
    throw new Error(`missing EonSystems file: ${EONSYSTEMS_NEURONS_PATH}`);
  }
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const firedStats = new Map<string, FiredStats>();
  let firstNonzeroTick = -1;
  let peakTick = -1;
  let peakCount = 0;
  const startedAt = Date.now();

  const conn = await BrainSocket.connect();
  try {
    await conn.request<{ ok: boolean }>('ping');
    const created = await conn.request<{ sim_id: number }>('create');
    const simId = created.sim_id;
    const steps = Array.from({ length: TICKS }, (_, i) => ({
      sim_id: simId,
      dt: DT,
      include_activity: true,
      fly: {
        x: 0,
        y: 0,
        z: 0.35,
        heading: 0,
        t: i * DT,
        hunger: 40,
        health: 100,
        rest_time_left: 0,
        dead: false,
      },
      sources: [SOURCE],
      pending: [],
    }));
    const res = await conn.request<{ results: Array<{ activity_sparse?: Record<string, number> }> }>(
      'step_many',
      { steps },
    );
    const results = res.results ?? [];
    for (let tick = 1; tick <= results.length; tick += 1) {
      const ids = Object.keys(results[tick - 1]?.activity_sparse ?? {});
      if (ids.length > 0 && firstNonzeroTick === -1) firstNonzeroTick = tick;
      if (ids.length > peakCount) {
        peakCount = ids.length;
        peakTick = tick;
      }
      for (const rid of ids) {
        const cur = firedStats.get(rid);
        if (!cur) {
          firedStats.set(rid, { spikeCount: 1, firstTick: tick, lastTick: tick });
        } else {
          cur.spikeCount += 1;
          if (tick < cur.firstTick) cur.firstTick = tick;
          if (tick > cur.lastTick) cur.lastTick = tick;
        }
      }
    }
  } finally {
    conn.close();
  }

  const cls = loadClassificationMap();
  writeNeurosimCsv(firedStats, cls);

  const eonIds = readCsvRootIds(EONSYSTEMS_NEURONS_PATH);
  const neuroIds = new Set(firedStats.keys());
  const overlap = [...neuroIds].filter((id) => eonIds.has(id)).sort();
  writeOverlapCsv(overlap, firedStats, cls);

  const overlapRatioNeuro = neuroIds.size > 0 ? overlap.length / neuroIds.size : 0;
  const overlapRatioEon = eonIds.size > 0 ? overlap.length / eonIds.size : 0;
  const summary = [
    'NeuroSim vs EonSystems overlap summary',
    `ticks_run: ${TICKS}`,
    `dt_sec: ${DT}`,
    `neurosim_unique_fired: ${neuroIds.size}`,
    `eonsystems_unique_fired: ${eonIds.size}`,
    `overlap_count: ${overlap.length}`,
    `overlap_ratio_of_neurosim: ${overlapRatioNeuro.toFixed(4)}`,
    `overlap_ratio_of_eonsystems: ${overlapRatioEon.toFixed(4)}`,
    `neurosim_first_nonzero_tick: ${firstNonzeroTick}`,
    `neurosim_peak_tick: ${peakTick}`,
    `neurosim_peak_count: ${peakCount}`,
    `elapsed_ms: ${Date.now() - startedAt}`,
    `neurosim_file: ${NEUROSIM_NEURONS_PATH}`,
    `eonsystems_file: ${EONSYSTEMS_NEURONS_PATH}`,
    `overlap_file: ${OVERLAP_PATH}`,
  ].join('\n');
  fs.writeFileSync(NEUROSIM_SUMMARY_PATH, `${summary}\n`, 'utf8');
  fs.writeFileSync(OVERLAP_SUMMARY_PATH, `${summary}\n`, 'utf8');

  console.log(`wrote ${NEUROSIM_NEURONS_PATH}`);
  console.log(`wrote ${NEUROSIM_SUMMARY_PATH}`);
  console.log(`wrote ${OVERLAP_PATH}`);
  console.log(`wrote ${OVERLAP_SUMMARY_PATH}`);
}

main().catch((err) => {
  console.error('[left-propagation-overlap] failed:', err);
  process.exitCode = 1;
});
