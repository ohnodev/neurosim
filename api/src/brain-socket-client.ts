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
let lastRequestTiming: {
  id: number;
  connectWaitMs: number;
  writeMs: number;
  responseWaitMs: number;
  totalMs: number;
  method: string;
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

function request<T>(payload: object): Promise<T> {
  const method = (payload as { method?: string })?.method ?? 'unknown';
  const reqId = ++requestSeq;
  const queued = requestChain.then(async () => {
    const t0 = performance.now();
    const { sock, rl } = await getConnection();
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
            };
            lastRequestTiming = timing;
            if (TRACE_SOCKET_TIMING) {
              console.log(
                `[brain-socket] req=${timing.id} method=${timing.method} connectWaitMs=${timing.connectWaitMs} writeMs=${timing.writeMs} responseWaitMs=${timing.responseWaitMs} totalMs=${timing.totalMs}`,
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
  requestChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
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
} | null {
  return lastRequestTiming;
}
