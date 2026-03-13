/**
 * Client for the brain-sim-service Unix socket.
 * Sends JSON-RPC style requests (method + params), receives JSON response per line.
 */
import { createConnection } from 'net';
import { createInterface } from 'readline';

const SOCKET_PATH =
  process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';

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

function request<T>(payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET_PATH, () => {
      const msg = JSON.stringify(payload) + '\n';
      sock.write(msg, (err) => {
        if (err) {
          sock.destroy();
          reject(err);
        }
      });
    });

    const rl = createInterface({ input: sock, crlfDelay: Infinity });
    rl.on('error', (err) => {
      rl.close();
      sock.destroy();
      reject(err);
    });
    rl.once('line', (line) => {
      rl.close();
      sock.destroy();
      try {
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

    sock.on('error', (err) => {
      rl.close();
      reject(err);
    });
  });
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
