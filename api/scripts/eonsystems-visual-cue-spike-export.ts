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

type ConnectomeNeuron = {
  root_id?: string;
  x?: number;
  y?: number;
};

type FlyState = {
  x: number;
  y: number;
  z: number;
  heading: number;
  t: number;
  hunger: number;
  health: number;
  rest_time_left: number;
  dead: boolean;
};

const ROOT = path.resolve(process.cwd(), '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const CLASSIFICATION_PATH = path.join(ROOT, 'data', 'raw', 'classification.csv');
const CONNECTOME_PATH = path.join(ROOT, 'data', 'connectome-full.json');
const OUT_CSV = path.join(LOGS_DIR, 'eonsystems_visual_cue_spikes_per_tick.csv');
const OUT_JSON = path.join(LOGS_DIR, 'eonsystems_visual_cue_spikes_per_tick.json');
const OUT_SUMMARY = path.join(LOGS_DIR, 'eonsystems_visual_cue_summary.txt');

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const REQUEST_TIMEOUT_MS = Number(process.env.NEUROSIM_BRAIN_REQUEST_TIMEOUT_MS ?? 30_000);
const TICKS = Math.max(1, Number(process.env.VISUAL_CUE_TICKS ?? 3000));
const DT_SEC = Number(process.env.VISUAL_CUE_DT_SEC ?? 0.0001);
const BASELINE_RATE_HZ = Math.max(0, Number(process.env.VISUAL_CUE_OLFACTORY_HZ ?? 0));
const VISUAL_STRIPE_HZ = Math.max(0, Number(process.env.VISUAL_CUE_STRIPE_HZ ?? 12));
const VISUAL_STRIPE_TARGET_COUNT = Math.max(1, Number(process.env.VISUAL_CUE_STRIPE_TARGET_COUNT ?? 400));
const VISUAL_CUE_SWITCH_TICK = Math.max(1, Number(process.env.VISUAL_CUE_SWITCH_TICK ?? 1));
const CUE_WORLD_X = Number(process.env.VISUAL_CUE_WORLD_X ?? 20);
const CUE_WORLD_Y = Number(process.env.VISUAL_CUE_WORLD_Y ?? 0);
const CUE_ANGULAR_SIGMA_DEG = Math.max(5, Number(process.env.VISUAL_CUE_ANGULAR_SIGMA_DEG ?? 30));
const VISUAL_CENTER_HALF_WIDTH_DEG = Math.max(1, Number(process.env.VISUAL_CUE_CENTER_HALF_WIDTH_DEG ?? 12));

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
    const payload = `${JSON.stringify({ method, params })}\n`;
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
      const remainingMs = timeoutAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`brain socket timeout after ${REQUEST_TIMEOUT_MS}ms`);
      }
      const chunk = await new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`brain socket timeout after ${REQUEST_TIMEOUT_MS}ms`));
        }, remainingMs);
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
          clearTimeout(timeoutId);
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

function normalizeAngleRad(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function loadPositionMap(): Map<string, { x: number; y: number }> {
  const raw = fs.readFileSync(CONNECTOME_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { neurons?: ConnectomeNeuron[] };
  const out = new Map<string, { x: number; y: number }>();
  for (const n of parsed.neurons ?? []) {
    const rootId = String(n.root_id ?? '');
    const x = Number(n.x);
    const y = Number(n.y);
    if (!rootId || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.set(rootId, { x, y });
  }
  return out;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function buildVisualAfferentPool(cls: Map<string, ClassificationRow>): Array<{ id: string; prefAngleRad: number }> {
  const posMap = loadPositionMap();
  const visualAfferent = [...cls.values()].filter(
    (r) => r.flow === 'afferent' && r.super_class === 'sensory' && r.class === 'visual',
  );
  const erRing = [...cls.values()].filter(
    (r) => r.flow === 'intrinsic'
      && r.super_class === 'central'
      && r.class === 'CX'
      && r.sub_class === 'ring_neuron'
      && r.hemibrain_type.startsWith('ER'),
  );
  // Prefer ER ring neurons for visual cue drive in this connectome: they couple to compass circuitry.
  const selectedDriverRows = erRing.length > 0 ? erRing : visualAfferent;
  const withPos = selectedDriverRows
    .map((r) => ({ id: r.root_id, pos: posMap.get(r.root_id) }))
    .filter((x): x is { id: string; pos: { x: number; y: number } } => x.pos != null);
  const cx = median(withPos.map((x) => x.pos.x));
  const cy = median(withPos.map((x) => x.pos.y));
  return withPos.map((x) => ({
    id: x.id,
    prefAngleRad: Math.atan2(x.pos.y - cy, x.pos.x - cx),
  }));
}

function chooseForcedVisualSpikes(
  pool: Array<{ id: string; prefAngleRad: number }>,
  fly: FlyState,
  rng: () => number,
): string[] {
  if (pool.length === 0 || VISUAL_STRIPE_HZ <= 0) return [];
  const cueAbsAngle = Math.atan2(CUE_WORLD_Y - fly.y, CUE_WORLD_X - fly.x);
  const cueRelAngle = normalizeAngleRad(cueAbsAngle - fly.heading);
  const sigma = (CUE_ANGULAR_SIGMA_DEG * Math.PI) / 180;
  const centerHalfWidthRad = (VISUAL_CENTER_HALF_WIDTH_DEG * Math.PI) / 180;
  const pBase = Math.min(1, VISUAL_STRIPE_HZ * DT_SEC);

  // Hard gate to center-only visual drive: no left/right channel stimulation.
  const scored = pool
    .map((n) => {
      const d = normalizeAngleRad(n.prefAngleRad - cueRelAngle);
      return { ...n, score: Math.abs(d), diff: d };
    })
    .filter((n) => n.score <= centerHalfWidthRad)
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.min(VISUAL_STRIPE_TARGET_COUNT, pool.length));

  const out: string[] = [];
  for (const n of scored) {
    const gain = Math.exp(-(n.diff * n.diff) / (2 * sigma * sigma));
    if (rng() < (pBase * gain)) out.push(n.id);
  }
  return out;
}

async function runVisualCueReplay(
  visualPool: Array<{ id: string; prefAngleRad: number }>,
): Promise<{ replay: ReplayJson; forcedSpikeEvents: number }> {
  const conn = await BrainSocket.connect();
  try {
    await conn.request<{ ok: boolean }>('ping');
    const created = await conn.request<{ sim_id: number }>('create');
    const simId = created.sim_id;
    const rng = createSeededRandom(0x3f5cb4a1);

    let fly: FlyState = {
      x: 0,
      y: 0,
      z: 0.35,
      heading: 0,
      t: 0,
      hunger: 40,
      health: 100,
      rest_time_left: 0,
      dead: false,
    };
    let forcedSpikeEvents = 0;
    const ticks: ReplayTick[] = [];

    for (let tick = 1; tick <= TICKS; tick += 1) {
      const forcedSpikes = tick >= VISUAL_CUE_SWITCH_TICK
        ? chooseForcedVisualSpikes(visualPool, fly, rng)
        : [];
      forcedSpikeEvents += forcedSpikes.length;
      const step = await conn.request<{
        activity_sparse?: Record<string, number>;
        fly: {
          x: number; y: number; z: number; heading: number; t: number;
          hunger: number; health: number; rest_time_left: number; dead: boolean;
        };
      }>('step', {
        sim_id: simId,
        dt: DT_SEC,
        include_activity: true,
        olfactory_baseline_rate_hz: BASELINE_RATE_HZ,
        fly,
        sources: [],
        forced_spikes: forcedSpikes,
      });
      const spikes = Object.keys(step.activity_sparse ?? {}).sort();
      ticks.push({
        tick,
        time_sec: tick * DT_SEC,
        spikes,
      });
      fly = {
        x: step.fly.x,
        y: step.fly.y,
        z: step.fly.z,
        heading: step.fly.heading,
        t: step.fly.t,
        hunger: step.fly.hunger,
        health: step.fly.health,
        rest_time_left: step.fly.rest_time_left,
        dead: step.fly.dead,
      };
    }

    return {
      replay: {
        meta: {
          ticks: ticks.length,
          dt_sec: DT_SEC,
          baseline_rate_hz: BASELINE_RATE_HZ,
          scenario: 'visual_cue_closed_loop_sensory_only',
          generated_at: new Date().toISOString(),
        },
        ticks,
      },
      forcedSpikeEvents,
    };
  } finally {
    conn.close();
  }
}

async function writeOutputs(
  replay: ReplayJson,
  cls: Map<string, ClassificationRow>,
  elapsedMs: number,
  forcedSpikeEvents: number,
  visualPoolSize: number,
): Promise<void> {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(replay, null, 2)}\n`, 'utf8');

  const csvStream = fs.createWriteStream(OUT_CSV, { encoding: 'utf8' });
  csvStream.write([
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
  ].join(','));
  csvStream.write('\n');
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
      csvStream.write([
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
      csvStream.write('\n');
    }
  }
  await new Promise<void>((resolve, reject) => {
    csvStream.on('error', reject);
    csvStream.end(() => resolve());
  });

  const summary = [
    'EonSystems visual-cue closed-loop replay summary',
    `scenario: ${replay.meta.scenario}`,
    `ticks: ${replay.meta.ticks}`,
    `dt_sec: ${replay.meta.dt_sec}`,
    `olfactory_baseline_rate_hz: ${replay.meta.baseline_rate_hz}`,
    `closed_loop: true`,
    `visual_driver_population: intrinsic/central/CX/ring_neuron/ER (fallback afferent/sensory/visual)`,
    `visual_pool_size: ${visualPoolSize}`,
    `visual_stripe_hz: ${VISUAL_STRIPE_HZ}`,
    `visual_stripe_target_count: ${VISUAL_STRIPE_TARGET_COUNT}`,
    `visual_center_half_width_deg: ${VISUAL_CENTER_HALF_WIDTH_DEG}`,
    `visual_cue_switch_tick: ${VISUAL_CUE_SWITCH_TICK}`,
    `visual_cue_world_xy: (${CUE_WORLD_X}, ${CUE_WORLD_Y})`,
    `visual_cue_sigma_deg: ${CUE_ANGULAR_SIGMA_DEG}`,
    `left_right_visual_forcing: 0 (center-only gate)`,
    `mechanosensory_forcing_hz: 0`,
    `visual_forced_spike_events: ${forcedSpikeEvents}`,
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
  const visualPool = buildVisualAfferentPool(cls);
  const { replay, forcedSpikeEvents } = await runVisualCueReplay(visualPool);
  const elapsedMs = Date.now() - startedAt;
  await writeOutputs(replay, cls, elapsedMs, forcedSpikeEvents, visualPool.length);
  console.log(`wrote ${OUT_JSON}`);
  console.log(`wrote ${OUT_CSV}`);
  console.log(`wrote ${OUT_SUMMARY}`);
  console.log(`elapsed_ms: ${elapsedMs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
