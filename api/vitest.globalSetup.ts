/**
 * Spawn brain-service before tests so the API can connect via Unix socket.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const SOCKET_PATH = process.env.NEUROSIM_BRAIN_SOCKET || '/tmp/neurosim-brain.sock';
const SERVICE_BIN = resolve(process.cwd(), 'brain-sim-service/target/release/brain-service');
const SERVICE_BIN_DEBUG = resolve(process.cwd(), 'brain-sim-service/target/debug/brain-service');

let brainProcess: ReturnType<typeof spawn> | null = null;

async function waitForSocket(ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (existsSync(SOCKET_PATH)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export default async function () {
  if (existsSync(SOCKET_PATH)) {
    return;
  }
  const bin = existsSync(SERVICE_BIN) ? SERVICE_BIN : existsSync(SERVICE_BIN_DEBUG) ? SERVICE_BIN_DEBUG : null;
  if (!bin) {
    throw new Error(
      'brain-service not built. Run: cd brain-sim-service && cargo build --release (or cargo build --release --no-default-features)',
    );
  }
  brainProcess = spawn(bin, [], {
    cwd: resolve(process.cwd(), 'brain-sim-service'),
    env: { ...process.env, NEUROSIM_BRAIN_SOCKET: SOCKET_PATH, USE_CUDA: '0' },
    stdio: 'ignore',
  });
  brainProcess.on('error', (err) => {
    console.error('[vitest] brain-service spawn error:', err);
  });
  const ok = await waitForSocket(5000);
  if (!ok) {
    brainProcess?.kill('SIGKILL');
    brainProcess = null;
    throw new Error('brain-service did not create socket in 5s');
  }
  return () => {
    if (brainProcess) {
      brainProcess.kill('SIGTERM');
      brainProcess = null;
    }
  };
}
