/**
 * Client for the brain-sim-service Unix socket.
 * Reuses a single connection for all requests (ping, create, step).
 */
import * as net from 'net';
import { createInterface } from 'readline';

const SOCKET_PATH =
  process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';

let sharedSocket: net.Socket | null = null;
let sharedRl: ReturnType<typeof createInterface> | null = null;
let connectPromise: Promise<void> | null = null;
let requestSeq = 0;
let requestChain: Promise<void> = Promise.resolve();
type JsonObj = Record<string, unknown>;
// TODO: step batching disabled – restore when step_many has full field parity
//   (bump_angle_deg, epg_bins) with single-step responses.
let lastRequestTiming: {
  id: number;
  connectWaitMs: number;
  writeMs: number;
  responseWaitMs: number;
  totalMs: number;
  method: string;
  batchSize?: number;
} | null = null;
const TRACE_SOCKET_TIMING = process.env.NEUROSIM_SOCKET_TRACE === '1';
const REQUEST_TIMEOUT_MS = Number(process.env.NEUROSIM_BRAIN_REQUEST_TIMEOUT_MS ?? 10_000);

function getConnection(): Promise<{ sock: net.Socket; rl: ReturnType<typeof createInterface> }> {
  if (sharedSocket && sharedRl && !sharedSocket.destroyed) {
    return Promise.resolve({ sock: sharedSocket, rl: sharedRl });
  }
  if (connectPromise) {
    return connectPromise.then(() => {
      if (sharedSocket && sharedRl) return { sock: sharedSocket, rl: sharedRl };
      throw new Error('Connection failed');
    });
  }
  connectPromise = new Promise<void>((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH, () => {
      sharedSocket = sock;
      sharedRl = createInterface({ input: sock, crlfDelay: Infinity });
      sock.setMaxListeners(20);
      sock.on('close', () => {
        sharedSocket = null;
        sharedRl = null;
        connectPromise = null;
      });
      resolve();
    });
    sock.on('error', (err) => {
      sharedSocket = null;
      sharedRl = null;
      connectPromise = null;
      reject(err);
    });
  });
  return connectPromise.then(() => {
    if (sharedSocket && sharedRl) return { sock: sharedSocket, rl: sharedRl };
    throw new Error('Connection failed');
  });
}

function enqueueRequest<T>(runner: () => Promise<T>): Promise<T> {
  const queued = requestChain.then(async () => {
    return runner();
  });
  requestChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

function sendRequest<T>(payload: JsonObj): Promise<T> {
  const method = (payload as { method?: string })?.method ?? 'unknown';
  const batchSize =
    method === 'step_many'
      ? (payload as { params?: { steps?: unknown[] } })?.params?.steps?.length ?? 0
      : undefined;
  const reqId = ++requestSeq;
  const t0 = performance.now();
  return getConnection().then(({ sock, rl }) => {
    const afterConnect = performance.now();
    return new Promise<T>((resolve, reject) => {
      const msg = JSON.stringify(payload) + '\n';
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        rl.off('line', onLine);
        sock.off('error', onError);
      };
      const failAndResetSocket = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        sharedSocket = null;
        sharedRl = null;
        connectPromise = null;
        sock.destroy();
        reject(err);
      };
      const onLine = (line: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          const done = performance.now();
          const timing = {
            id: reqId,
            connectWaitMs: Math.round(afterConnect - t0),
            writeMs: Math.round(afterWrite - afterConnect),
            responseWaitMs: Math.round(done - afterWrite),
            totalMs: Math.round(done - t0),
            method,
            batchSize,
          };
          lastRequestTiming = timing;
          if (TRACE_SOCKET_TIMING) {
            console.log(
              `[brain-socket] req=${timing.id} method=${timing.method}${timing.batchSize != null ? ` batchSize=${timing.batchSize}` : ''} connectWaitMs=${timing.connectWaitMs} writeMs=${timing.writeMs} responseWaitMs=${timing.responseWaitMs} totalMs=${timing.totalMs}`,
            );
          }
          const out = JSON.parse(line) as T;
          if ('error' in (out as { error?: string }) && (out as { error?: string }).error) {
            reject(new Error((out as { error: string }).error));
          } else {
            resolve(out);
          }
        } catch (e) {
          reject(e);
        }
      };
      const onError = (err: Error) => {
        failAndResetSocket(err);
      };
      let afterWrite = afterConnect;
      timeoutHandle = setTimeout(() => {
        failAndResetSocket(new Error(`brain socket request timeout after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      rl.on('line', onLine);
      sock.on('error', onError);
      sock.write(msg, (err) => {
        if (err) {
          failAndResetSocket(err);
          return;
        }
        afterWrite = performance.now();
      });
    });
  });
}

function request<T>(payload: object): Promise<T> {
  return enqueueRequest(() => sendRequest(payload as JsonObj));
}

/** No params: brain-service uses connectome loaded at startup */
export interface CreateParams {
  neuronIds?: string[];
  connections?: Array<{ pre: string; post: string; weight?: number }>;
  sensoryIndices?: number[];
  motorLeft?: number[];
  motorRight?: number[];
  motorUnknown?: number[];
}

export interface StepParams {
  simId: number;
  dt: number;
  olfactory_baseline_rate_hz?: number;
  /** When present and non-empty: PEN_a rates for this step; olfactory/sensory drive is skipped. */
  ratesById?: Record<string, number>;
  forced_spikes?: string[];
  includeActivity?: boolean;
  fly: {
    x: number;
    y: number;
    z: number;
    heading: number;
    t: number;
    hunger: number;
    health: number;
    restTimeLeft: number;
    dead: boolean;
  };
  sources: Array<{ id: string; x: number; y: number; radius: number }>;
}

export interface StepResult {
  activity: number[];
  activitySparse: Record<string, number>;
  motorLeft: number;
  motorRight: number;
  motorFwd: number;
  motorLeftCount: number;
  motorRightCount: number;
  motorFwdCount: number;
  motorLeftMagnitude: number;
  motorRightMagnitude: number;
  motorFwdMagnitude: number;
  fly: {
    x: number;
    y: number;
    z: number;
    heading: number;
    t: number;
    hunger: number;
    health: number;
    dead: boolean;
    flyTimeLeft: number;
    restTimeLeft: number;
    restDuration: number;
    feeding: boolean;
  };
  eatenFoodIds?: string[];
  feedingSugarTaken?: number;
  /** EPG bump heading in degrees (math convention), when available. */
  bumpAngleDeg?: number | null;
  /** Normalized EPG bin activities 0..1 (16 bins), for compass display. */
  epgBins?: number[] | null;
  computeMs?: number;
  kernelMs?: number;
  recurrentMs?: number;
  lifMs?: number;
  readoutMs?: number;
}

export interface StepManyItem {
  simId: number;
  dt: number;
  includeActivity?: boolean;
  olfactoryBaselineRateHz?: number;
  forcedSpikes?: string[];
  fly: {
    x: number;
    y: number;
    z: number;
    heading: number;
    t: number;
    hunger: number;
    health: number;
    restTimeLeft: number;
    dead: boolean;
  };
  sources: Array<{ id: string; x: number; y: number; radius: number }>;
}

export interface StepManyResultItem {
  simId: number;
  activitySparse: Record<string, number>;
  motorLeft: number;
  motorRight: number;
  motorFwd: number;
  motorLeftCount: number;
  motorRightCount: number;
  motorFwdCount: number;
  motorLeftMagnitude: number;
  motorRightMagnitude: number;
  motorFwdMagnitude: number;
  fly: StepResult['fly'];
  eatenFoodIds?: string[];
  feedingSugarTaken?: number;
  computeMs?: number;
  kernelMs?: number;
  recurrentMs?: number;
  lifMs?: number;
  readoutMs?: number;
}

export interface ReplayTick {
  tick: number;
  time_sec: number;
  spikes: string[];
  totalSpikeEventsStep?: number;
  afferentSpikeEventsStep?: number;
  olfactorySpikeEventsStep?: number;
  afferentSpikeIdsStep?: string[];
  olfactorySpikeIdsStep?: string[];
}

/** Lightweight handshake: verify brain-service is reachable. */
export async function ping(): Promise<void> {
  const res = await request<{ ok?: boolean }>({ method: 'ping' });
  if (!res?.ok) throw new Error('brain-service ping failed');
}

export async function createSim(params?: CreateParams & {
  rngSeed?: number;
  epgRecurrenceBoost?: number;
}): Promise<{ simId: number }> {
  const { rngSeed, epgRecurrenceBoost, ...rest } = (params ?? {});
  const toSnakeKey = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const p: JsonObj = {};
  for (const [k, v] of Object.entries(rest as JsonObj)) {
    p[toSnakeKey(k)] = v;
  }
  if (rngSeed != null && Number.isFinite(rngSeed)) {
    p.rng_seed = Math.floor(rngSeed as number);
  }
  if (epgRecurrenceBoost != null && Number.isFinite(epgRecurrenceBoost)) {
    p.epg_recurrence_boost = epgRecurrenceBoost as number;
  }
  const res = await request<{ sim_id: number }>({ method: 'create', params: p });
  return { simId: res.sim_id };
}

/** Continuous live sim: set PEN_a L/R Hz (applies on next step). Optional ratesById overrides per neuron. */
export async function liveSetPenA(
  leftHz: number,
  rightHz: number,
  ratesById?: Record<string, number>,
): Promise<void> {
  const params: { left_hz: number; right_hz: number; rates_by_id?: Record<string, number> } = {
    left_hz: leftHz,
    right_hz: rightHz,
  };
  if (ratesById && Object.keys(ratesById).length > 0) {
    params.rates_by_id = ratesById;
  }
  await request<{ ok?: boolean }>({ method: 'live_set_pen_a', params });
}

export async function liveReadTicks(
  afterTick: number,
  maxTicks = 2000,
): Promise<{
  ticks: Array<{ tick: number; time_sec: number; spikes: string[] }>;
  latest_tick: number;
  dt_sec: number;
}> {
  return request({
    method: 'live_read_ticks',
    params: {
      after_tick: Math.max(0, Math.floor(afterTick)),
      max_ticks: Math.min(8000, Math.max(1, Math.floor(maxTicks))),
    },
  });
}

export async function liveStatus(): Promise<{
  ok?: boolean;
  latest_tick: number;
  left_hz: number;
  right_hz: number;
  dt_sec: number;
  rates_by_id?: Record<string, number> | null;
}> {
  return request({
    method: 'live_status',
    params: {},
  });
}

export interface RunStepsWithStateParams {
  simId: number;
  numSteps: number;
  dt: number;
  stimRatesById?: Record<string, number>;
  fly: {
    x: number;
    y: number;
    z: number;
    heading: number;
    t: number;
    hunger: number;
    health: number;
    restTimeLeft: number;
    dead: boolean;
  };
  sources: Array<{ id: string; x: number; y: number; radius: number }>;
}

export interface RunStepsWithStateResult {
  activitySparse: Record<string, number>;
  bumpAngleDeg?: number | null;
  epgBins?: number[] | null;
}

/** Run N steps in one round-trip; world path returns EPG-only readout. */
export async function runStepsWithState(params: RunStepsWithStateParams): Promise<RunStepsWithStateResult> {
  const res = await request<{
    steps_done: number;
    activity_sparse?: Record<string, number>;
    bump_angle_deg?: number | null;
    epg_bins?: number[] | null;
  }>({
    method: 'run_steps',
    params: {
      sim_id: params.simId,
      num_steps: Math.min(1_000_000, Math.max(1, Math.floor(params.numSteps))),
      dt: params.dt,
      ...(params.stimRatesById && Object.keys(params.stimRatesById).length > 0
        ? { stim_rates_by_id: params.stimRatesById }
        : {}),
      return_final_state: true,
      fly: {
        x: params.fly.x,
        y: params.fly.y,
        z: params.fly.z,
        heading: params.fly.heading,
        t: params.fly.t,
        hunger: params.fly.hunger,
        health: params.fly.health,
        rest_time_left: params.fly.restTimeLeft,
        dead: params.fly.dead,
      },
      sources: params.sources,
    },
  });
  return {
    activitySparse: res.activity_sparse ?? {},
    bumpAngleDeg: res.bump_angle_deg ?? null,
    epgBins: res.epg_bins ?? null,
  };
}

export async function runSteps(params: {
  simId: number;
  numSteps: number;
  dt: number;
  stimRatesById: Record<string, number>;
  countNeuronIds?: string[];
  recordTicks: boolean;
}): Promise<{
  steps_done: number;
  duration_sec: number;
  wall_sec: number;
  steps_loop_ms: number;
  ticks?: Array<{ tick: number; time_sec: number; spikes: string[] }>;
}> {
  return request({
    method: 'run_steps',
    params: {
      sim_id: params.simId,
      num_steps: Math.min(1_000_000, Math.max(1, Math.floor(params.numSteps))),
      dt: params.dt,
      stim_rates_by_id: params.stimRatesById,
      count_neuron_ids: params.countNeuronIds,
      record_ticks: params.recordTicks,
    },
  });
}

export async function stepSim(params: StepParams): Promise<StepResult> {
  const res = await request<{
    activity_sparse: Record<string, number>;
    motor_left: number;
    motor_right: number;
    motor_fwd: number;
    motor_left_count: number;
    motor_right_count: number;
    motor_fwd_count: number;
    motor_left_magnitude: number;
    motor_right_magnitude: number;
    motor_fwd_magnitude: number;
    fly: {
      x: number;
      y: number;
      z: number;
      heading: number;
      t: number;
      hunger: number;
      health: number;
      dead: boolean;
      fly_time_left: number;
      rest_time_left: number;
      rest_duration: number;
      feeding: boolean;
    };
    eaten_food_id?: string;
    feeding_sugar_taken?: number;
    bump_angle_deg?: number | null;
    epg_bins?: number[] | null;
    compute_ms?: number;
    kernel_ms?: number;
    recurrent_ms?: number;
    lif_ms?: number;
    readout_ms?: number;
  }>({
    method: 'step',
    params: {
      sim_id: params.simId,
      dt: params.dt,
      olfactory_baseline_rate_hz: params.olfactory_baseline_rate_hz,
      forced_spikes: params.forced_spikes ?? [],
      fly: {
        x: params.fly.x,
        y: params.fly.y,
        z: params.fly.z,
        heading: params.fly.heading,
        t: params.fly.t,
        hunger: params.fly.hunger,
        health: params.fly.health,
        rest_time_left: params.fly.restTimeLeft,
        dead: params.fly.dead,
      },
      sources: params.sources,
      include_activity: params.includeActivity ?? true,
      ...(params.ratesById && Object.keys(params.ratesById).length > 0
        ? { rates_by_id: params.ratesById }
        : {}),
    },
  });
  return {
    activity: [],
    activitySparse: res.activity_sparse ?? {},
    motorLeft: res.motor_left,
    motorRight: res.motor_right,
    motorFwd: res.motor_fwd,
    motorLeftCount: res.motor_left_count ?? 0,
    motorRightCount: res.motor_right_count ?? 0,
    motorFwdCount: res.motor_fwd_count ?? 0,
    motorLeftMagnitude: res.motor_left_magnitude ?? 0,
    motorRightMagnitude: res.motor_right_magnitude ?? 0,
    motorFwdMagnitude: res.motor_fwd_magnitude ?? 0,
    fly: {
      x: res.fly.x,
      y: res.fly.y,
      z: res.fly.z,
      heading: res.fly.heading,
      t: res.fly.t,
      hunger: res.fly.hunger,
      health: res.fly.health,
      dead: res.fly.dead,
      flyTimeLeft: res.fly.fly_time_left,
      restTimeLeft: res.fly.rest_time_left,
      restDuration: res.fly.rest_duration,
      feeding: res.fly.feeding,
    },
    eatenFoodIds: res.eaten_food_id ? [res.eaten_food_id] : undefined,
    feedingSugarTaken: res.feeding_sugar_taken,
    bumpAngleDeg: res.bump_angle_deg ?? null,
    epgBins: res.epg_bins ?? null,
    computeMs: res.compute_ms,
    kernelMs: res.kernel_ms,
    recurrentMs: res.recurrent_ms,
    lifMs: res.lif_ms,
    readoutMs: res.readout_ms,
  };
}

export async function stepMany(
  items: StepManyItem[],
): Promise<Map<number, StepManyResultItem>> {
  const res = await request<{
    results: Array<{
      sim_id: number;
      activity_sparse: Record<string, number>;
      motor_left: number;
      motor_right: number;
      motor_fwd: number;
      motor_left_count: number;
      motor_right_count: number;
      motor_fwd_count: number;
      motor_left_magnitude: number;
      motor_right_magnitude: number;
      motor_fwd_magnitude: number;
      fly: {
        x: number;
        y: number;
        z: number;
        heading: number;
        t: number;
        hunger: number;
        health: number;
        dead: boolean;
        fly_time_left: number;
        rest_time_left: number;
        rest_duration: number;
        feeding: boolean;
      };
      eaten_food_id?: string;
      feeding_sugar_taken?: number;
      compute_ms?: number;
      kernel_ms?: number;
      recurrent_ms?: number;
      lif_ms?: number;
      readout_ms?: number;
    }>;
  }>({
    method: 'step_many',
    params: {
      steps: items.map((item) => ({
        sim_id: item.simId,
        dt: item.dt,
        fly: {
          x: item.fly.x,
          y: item.fly.y,
          z: item.fly.z,
          heading: item.fly.heading,
          t: item.fly.t,
          hunger: item.fly.hunger,
          health: item.fly.health,
          rest_time_left: item.fly.restTimeLeft,
          dead: item.fly.dead,
        },
        sources: item.sources,
        include_activity: item.includeActivity ?? true,
        olfactory_baseline_rate_hz: item.olfactoryBaselineRateHz,
        forced_spikes: item.forcedSpikes ?? [],
      })),
    },
  });
  const out = new Map<number, StepManyResultItem>();
  for (const item of res.results ?? []) {
    out.set(item.sim_id, {
      simId: item.sim_id,
      activitySparse: item.activity_sparse ?? {},
      motorLeft: item.motor_left,
      motorRight: item.motor_right,
      motorFwd: item.motor_fwd,
      motorLeftCount: item.motor_left_count ?? 0,
      motorRightCount: item.motor_right_count ?? 0,
      motorFwdCount: item.motor_fwd_count ?? 0,
      motorLeftMagnitude: item.motor_left_magnitude ?? 0,
      motorRightMagnitude: item.motor_right_magnitude ?? 0,
      motorFwdMagnitude: item.motor_fwd_magnitude ?? 0,
      fly: {
        x: item.fly.x,
        y: item.fly.y,
        z: item.fly.z,
        heading: item.fly.heading,
        t: item.fly.t,
        hunger: item.fly.hunger,
        health: item.fly.health,
        dead: item.fly.dead,
        flyTimeLeft: item.fly.fly_time_left,
        restTimeLeft: item.fly.rest_time_left,
        restDuration: item.fly.rest_duration,
        feeding: item.fly.feeding,
      },
      eatenFoodIds: item.eaten_food_id ? [item.eaten_food_id] : undefined,
      feedingSugarTaken: item.feeding_sugar_taken,
      computeMs: item.compute_ms,
      kernelMs: item.kernel_ms,
      recurrentMs: item.recurrent_ms,
      lifMs: item.lif_ms,
      readoutMs: item.readout_ms,
    });
  }
  return out;
}

export async function runReplayBatch(params: {
  simId: number;
  dt: number;
  startTick: number;
  count: number;
  olfactoryBaselineRateHz?: number;
  forcedSpikesByStep?: string[][];
}): Promise<ReplayTick[]> {
  const steps = Array.from({ length: params.count }, (_, i) => ({
    sim_id: params.simId,
    dt: params.dt,
    include_activity: true,
    olfactory_baseline_rate_hz: params.olfactoryBaselineRateHz,
    forced_spikes: params.forcedSpikesByStep?.[i] ?? [],
    fly: {
      x: 0,
      y: 0,
      z: 0.35,
      heading: 0,
      t: (params.startTick + i - 1) * params.dt,
      hunger: 40,
      health: 100,
      rest_time_left: 0,
      dead: false,
    },
    sources: [],
  }));
  const res = await request<{ results: Array<{ activity_sparse?: Record<string, number> }> }>({
    method: 'step_many',
    params: { steps },
  });
  return (res.results ?? []).map((item, i) => ({
    tick: params.startTick + i,
    time_sec: (params.startTick + i) * params.dt,
    spikes: Object.keys(item.activity_sparse ?? {}).sort(),
  }));
}

export function isSocketAvailable(): boolean {
  try {
    const fs = require('fs');
    return fs.existsSync(SOCKET_PATH);
  } catch {
    return false;
  }
}

export function getLastRequestTiming(): {
  id: number;
  connectWaitMs: number;
  writeMs: number;
  responseWaitMs: number;
  totalMs: number;
  method: string;
  batchSize?: number;
} | null {
  return lastRequestTiming;
}
