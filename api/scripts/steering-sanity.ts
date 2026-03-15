import net from 'node:net';

type Source = { id: string; x: number; y: number; radius: number };

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const REQUEST_TIMEOUT_MS = Number(process.env.NEUROSIM_SANITY_TIMEOUT_MS ?? 60_000);

class BrainSocket {
  private socket: net.Socket;
  private buffer = '';

  constructor(socket: net.Socket) {
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

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    const payload = JSON.stringify({ method, params }) + '\n';
    this.socket.write(payload);
    return await this.readJsonLine<T>();
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
        throw new Error(`sanity socket read timeout after ${REQUEST_TIMEOUT_MS}ms`);
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

function normalizeAngle(a: number): number {
  let out = a;
  while (out > Math.PI) out -= 2 * Math.PI;
  while (out < -Math.PI) out += 2 * Math.PI;
  return out;
}

async function runScenario(name: string, sources: Source[], steps = 240, dt = 1 / 30): Promise<void> {
  const conn = await BrainSocket.connect();
  try {
    await conn.request<{ ok: boolean }>('ping');
    const create = await conn.request<{ sim_id: number }>('create');
    const simId = create.sim_id;

    let fly = {
      x: 0,
      y: 0,
      z: 1.0,
      heading: 0,
      t: 0,
      hunger: 40,
      health: 100,
      rest_time_left: 0,
      dead: false,
    };
  let sumTurn = 0;
  let posTurns = 0;
  let negTurns = 0;
  let sumMotorCountDiff = 0;
  let sumMotorMagDiff = 0;
  let sumMotorScaledDiff = 0;
    let finalHeading = 0;

  for (let i = 0; i < steps; i++) {
      const prevHeading = fly.heading ?? 0;
      const out = await conn.request<{
        motor_left: number;
        motor_right: number;
        motor_fwd: number;
        motor_left_count: number;
        motor_right_count: number;
        motor_left_magnitude: number;
        motor_right_magnitude: number;
        fly: {
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
      }>('step', {
        sim_id: simId,
        dt,
        include_activity: false,
        fly,
        sources,
      });
      fly = {
        ...out.fly,
        rest_time_left: out.fly.rest_time_left ?? 0,
        dead: out.fly.dead ?? false,
      };
      const nextHeading = fly.heading ?? 0;
    const d = normalizeAngle(nextHeading - prevHeading);
    sumTurn += d;
    if (d > 0) posTurns += 1;
    if (d < 0) negTurns += 1;
      sumMotorCountDiff += (out.motor_right_count ?? 0) - (out.motor_left_count ?? 0);
      sumMotorMagDiff += (out.motor_right_magnitude ?? 0) - (out.motor_left_magnitude ?? 0);
      sumMotorScaledDiff += (out.motor_right ?? 0) - (out.motor_left ?? 0);
      finalHeading = nextHeading;
    }
    const avgTurn = sumTurn / steps;
    const avgCountDiff = sumMotorCountDiff / steps;
    const avgMagDiff = sumMotorMagDiff / steps;
    const avgScaledDiff = sumMotorScaledDiff / steps;
    const dominant = posTurns === negTurns ? 'mixed' : posTurns > negTurns ? 'left(+)' : 'right(-)';
    console.log(
      JSON.stringify({
        scenario: name,
        steps,
        avg_turn_rad_per_step: Number(avgTurn.toFixed(5)),
        cumulative_turn_rad: Number(sumTurn.toFixed(4)),
        turn_sign_pos_steps: posTurns,
        turn_sign_neg_steps: negTurns,
        dominant_turn: dominant,
        avg_motor_count_diff_r_minus_l: Number(avgCountDiff.toFixed(4)),
        avg_motor_mag_diff_r_minus_l: Number(avgMagDiff.toFixed(4)),
        avg_motor_scaled_diff_r_minus_l: Number(avgScaledDiff.toFixed(6)),
        final_heading_rad: Number(finalHeading.toFixed(4)),
      }),
    );
  } finally {
    conn.close();
  }
}

async function main(): Promise<void> {
  const r = 3.2;
  await runScenario('left-only', [{ id: 'left', x: 0, y: 12, radius: r }]);
  await runScenario('right-only', [{ id: 'right', x: 0, y: -12, radius: r }]);
  await runScenario('ahead-only', [{ id: 'ahead', x: 12, y: 0, radius: r }]);
  await runScenario('both-symmetric', [
    { id: 'left', x: 0, y: 12, radius: r },
    { id: 'right', x: 0, y: -12, radius: r },
  ]);
}

main().catch((err) => {
  console.error('[steering-sanity] failed:', err);
  process.exitCode = 1;
});
