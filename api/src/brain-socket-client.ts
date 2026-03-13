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
type QueuedStep = {
  payload: JsonObj;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};
let pendingStepBatch: QueuedStep[] = [];
let flushStepBatchScheduled = false;
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
      const onError = (err: Error) => {
        sharedSocket = null;
        sharedRl = null;
        connectPromise = null;
        sock.off('error', onError);
        reject(err);
      };
      sock.on('error', onError);
      sock.write(msg, (err) => {
        if (err) {
          sock.off('error', onError);
          sharedSocket = null;
          sharedRl = null;
          connectPromise = null;
          reject(err);
          return;
        }
        const afterWrite = performance.now();
        rl.once('line', (line) => {
          sock.off('error', onError);
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
        });
      });
    });
  });
}

function flushStepBatch(): void {
  const batch = pendingStepBatch;
  pendingStepBatch = [];
  flushStepBatchScheduled = false;
  if (batch.length === 0) return;

  if (batch.length === 1) {
    const one = batch[0];
    void enqueueRequest(() => sendRequest(one.payload)).then(one.resolve, one.reject);
    return;
  }

  const steps = batch.map((q) => {
    const params = (q.payload as { params?: JsonObj }).params ?? {};
    const fly = (params.fly as JsonObj | undefined) ?? {};
    const pending = Array.isArray(params.pending) ? params.pending : [];
    return {
      sim_id: params.sim_id,
      dt: params.dt,
      fly: {
        x: fly.x,
        y: fly.y,
        z: fly.z,
        heading: fly.heading,
        t: fly.t,
        hunger: fly.hunger,
        health: fly.health,
        rest_time_left: fly.rest_time_left,
      },
      sources: params.sources ?? [],
      pending: pending.map((p) => {
        const item = p as { neuronIds?: unknown; neuron_ids?: unknown; strength?: unknown };
        return {
          neuron_ids: item.neuron_ids ?? item.neuronIds ?? [],
          strength: item.strength ?? 0,
        };
      }),
    };
  });

  const manyPayload: JsonObj = {
    method: 'step_many',
    params: { steps },
  };
  void enqueueRequest(() => sendRequest<{ results: Array<{
    sim_id: number;
    activity_sparse: Record<string, number>;
    motor_left: number;
    motor_right: number;
    motor_fwd: number;
  }> }>(manyPayload)).then((res) => {
    const bySim = new Map<number, {
      sim_id: number;
      activity_sparse: Record<string, number>;
      motor_left: number;
      motor_right: number;
      motor_fwd: number;
    }>();
    for (const r of res.results ?? []) bySim.set(r.sim_id, r);
    for (const q of batch) {
      const simId = Number((q.payload as { params?: { sim_id?: number } }).params?.sim_id);
      const item = bySim.get(simId);
      if (!item) {
        q.reject(new Error(`step_many missing result for sim ${simId}`));
        continue;
      }
      q.resolve(item);
    }
  }, (err) => {
    for (const q of batch) q.reject(err);
  });
}

function request<T>(payload: object): Promise<T> {
  const method = (payload as { method?: string })?.method ?? 'unknown';
  if (method === 'step') {
    return new Promise<T>((resolve, reject) => {
      pendingStepBatch.push({
        payload: payload as JsonObj,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      if (!flushStepBatchScheduled) {
        flushStepBatchScheduled = true;
        queueMicrotask(flushStepBatch);
      }
    });
  }
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
  fly: {
    x: number;
    y: number;
    z: number;
    heading: number;
    t: number;
    hunger: number;
    health: number;
    restTimeLeft: number;
  };
  sources: Array<{ x: number; y: number; radius: number }>;
  pending: Array<{ neuronIds: string[]; strength: number }>;
}

export interface StepResult {
  activity: number[];
  activitySparse: Record<string, number>;
  motorLeft: number;
  motorRight: number;
  motorFwd: number;
}

export interface StepManyItem {
  simId: number;
  dt: number;
  fly: {
    x: number;
    y: number;
    z: number;
    heading: number;
    t: number;
    hunger: number;
    health: number;
    restTimeLeft: number;
  };
  sources: Array<{ x: number; y: number; radius: number }>;
  pending: Array<{ neuronIds: string[]; strength: number }>;
}

export interface StepManyResultItem {
  simId: number;
  activitySparse: Record<string, number>;
  motorLeft: number;
  motorRight: number;
  motorFwd: number;
}

/** Lightweight handshake: verify brain-service is reachable. */
export async function ping(): Promise<void> {
  const res = await request<{ ok?: boolean }>({ method: 'ping' });
  if (!res?.ok) throw new Error('brain-service ping failed');
}

export async function createSim(_params?: CreateParams): Promise<{ simId: number }> {
  const res = await request<{ sim_id: number }>({ method: 'create', params: {} });
  return { simId: res.sim_id };
}

export async function stepSim(params: StepParams): Promise<StepResult> {
  const res = await request<{
    activity_sparse: Record<string, number>;
    motor_left: number;
    motor_right: number;
    motor_fwd: number;
  }>({
    method: 'step',
    params: {
      sim_id: params.simId,
      dt: params.dt,
      fly: {
        x: params.fly.x,
        y: params.fly.y,
        z: params.fly.z,
        heading: params.fly.heading,
        t: params.fly.t,
        hunger: params.fly.hunger,
        health: params.fly.health,
        rest_time_left: params.fly.restTimeLeft,
      },
      sources: params.sources,
      pending: params.pending,
    },
  });
  return {
    activity: [],
    activitySparse: res.activity_sparse ?? {},
    motorLeft: res.motor_left,
    motorRight: res.motor_right,
    motorFwd: res.motor_fwd,
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
        },
        sources: item.sources,
        pending: item.pending.map((p) => ({
          neuron_ids: p.neuronIds,
          strength: p.strength,
        })),
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
    });
  }
  return out;
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
