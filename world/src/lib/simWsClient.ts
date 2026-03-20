/**
 * GraphQL WebSocket client for world simulation stream.
 * Read-only from frontend perspective: we subscribe to server state and only
 * send view selection (which fly index to inspect).
 */
import { createClient, type Client } from "graphql-ws";
import { getWsUrl } from "./wsUrl";
import type { FlyState } from "../../../api/src/fly-state";
import type { WorldSource } from "../../../api/src/world";

export type { FlyState };

export interface WorldTick {
  tick: number;
  fly_id: number;
  time_sec: number;
  epg: number[];
}

/** Per-neuron EPG spikes: spikes[neuronIndex] = [tick1, tick2, ...]. Compact format for replay. */
export interface EpgSpikesByNeuronFly {
  flyId: number;
  tickStart: number;
  tickEnd: number;
  spikes: number[][];
}

export interface SimPayload {
  t?: number;
  /** Multi-fly: array of fly states */
  flies?: FlyState[];
  /** Legacy: single fly (prefer flies when present) */
  fly?: FlyState;
  /** Batched frames: server sends 8 frames every 250ms. activity + sources sent once per batch. */
  frames?: {
    t: number;
    flies: FlyState[];
    bumpAngleDegs?: (number | null)[];
    epgBinsPerSim?: (number[] | null)[];
  }[];
  /** Per-step EPG ticks for frontend bump derivation. */
  ticks?: WorldTick[];
  /** Per-neuron format: spikes[neuronIndex] = [tick1, tick2, ...]. Full EPG activity for replay. */
  epgSpikesByNeuronByFly?: EpgSpikesByNeuronFly[];
  epgIndexToBin?: number[];
  worldDtSec?: number;
  worldStepsPerBatch?: number;
  flyIdBySimIndex?: number[];
  activity?: Record<string, number>;
  /** Per-fly brain activity (index = sim index) */
  activities?: (Record<string, number> | undefined)[];
  /** Per-client motor readout for currently viewed sim index. */
  motor?: {
    left: number;
    right: number;
    fwd: number;
    leftCount: number;
    rightCount: number;
    fwdCount: number;
    leftMagnitude: number;
    rightMagnitude: number;
    fwdMagnitude: number;
  };
  simRunning?: boolean;
  sources?: WorldSource[];
  error?: string;
}

export type SimEvent = SimPayload | { _event: "open" } | { _event: "closed" } | { _event: "error"; error: string };
type Listener = (event: SimEvent) => void;

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;
const SUBSCRIPTION = `
  subscription WorldSimulation($viewFlyIndex: Int) {
    worldSimulation(viewFlyIndex: $viewFlyIndex)
  }
`;

let client: Client | null = null;
let listeners = new Set<Listener>();
let lastPayload: SimPayload | null = null;
let lastError: string | null = null;
let lastMessageTime = 0;
let retryDelayMs = INITIAL_RETRY_MS;
let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
let subscriptionRunId = 0;
let subscriptionStarted = false;
let disposed = false;
let currentViewFlyIndex = 0;

function scheduleRestart(): void {
  if (retryTimeoutId != null || disposed) return;
  const jitter = retryDelayMs * 0.2 * (Math.random() - 0.5);
  const delay = Math.min(
    MAX_RETRY_DELAY_MS,
    Math.max(INITIAL_RETRY_MS, Math.floor(retryDelayMs + jitter))
  );
  retryTimeoutId = setTimeout(() => {
    retryTimeoutId = null;
    retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * BACKOFF_FACTOR);
    startSubscription();
  }, delay);
}

function clearClient(): void {
  if (!client) return;
  try {
    const disposeResult = client.dispose();
    if (disposeResult && typeof (disposeResult as Promise<void>).catch === "function") {
      (disposeResult as Promise<void>).catch(() => {
        /* ignore */
      });
    }
  } catch {
    /* ignore */
  }
  client = null;
  subscriptionStarted = false;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const s = String(err);
  if (s === "[object Event]" || s === "[object Object]") return "Connection error";
  return s || "Connection error";
}

function startSubscription(): void {
  if (disposed || listeners.size === 0 || subscriptionStarted) return;
  subscriptionStarted = true;
  const runId = ++subscriptionRunId;
  const url = getWsUrl();
  client = createClient({
    url,
    on: {
      connected: () => {
        retryDelayMs = INITIAL_RETRY_MS;
        lastError = null;
        for (const fn of listeners) fn({ _event: "open" });
      },
      closed: () => {
        for (const fn of listeners) fn({ _event: "closed" });
      },
      error: (error) => {
        const message = toErrorMessage(error);
        lastError = message;
        for (const fn of listeners) fn({ _event: "error", error: message });
      },
    },
  });
  const iterator = client.iterate({
    query: SUBSCRIPTION,
    variables: { viewFlyIndex: currentViewFlyIndex },
  });
  (async () => {
    try {
      for await (const result of iterator) {
        if (result.errors?.length) {
          const message = result.errors.map((e) => e.message).join("; ");
          lastError = message || "Subscription error";
          for (const fn of listeners) fn({ _event: "error", error: lastError });
          continue;
        }
        const raw = (result.data as { worldSimulation?: string } | undefined)?.worldSimulation;
        if (typeof raw !== "string") continue;
        const data = JSON.parse(raw) as SimPayload;
        if (data.error) {
          lastError = data.error;
        } else {
          lastPayload = data;
          lastError = null;
          lastMessageTime = Date.now();
        }
        for (const fn of listeners) fn(data);
      }
    } catch (err) {
      lastError = toErrorMessage(err);
      for (const fn of listeners) fn({ _event: "error", error: lastError });
    } finally {
      if (runId !== subscriptionRunId) return;
      clearClient();
      if (listeners.size > 0 && !disposed) scheduleRestart();
    }
  })();
}

function restartSubscriptionForViewChange(): void {
  clearClient();
  startSubscription();
}

/**
 * Subscribe to sim payloads. Starts connection on first subscriber.
 * @returns Unsubscribe function.
 */
export function subscribeSim(listener: Listener): () => void {
  listeners.add(listener);
  startSubscription();
  if (lastPayload) {
    try {
      listener(lastPayload);
    } catch {
      /* ignore */
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearClient();
  };
}

/** Tell server which fly's activity to send (sim index). Reduces payload size. */
export function sendViewFlyIndex(simIndex: number): void {
  if (!Number.isInteger(simIndex) || simIndex < 0) return;
  if (currentViewFlyIndex !== simIndex) {
    currentViewFlyIndex = simIndex;
    if (!disposed && listeners.size > 0) restartSubscriptionForViewChange();
  }
}

export function getConnectionState(): "connecting" | "open" | "closed" {
  if (subscriptionStarted && client) return "open";
  if (!disposed && listeners.size > 0) return "connecting";
  return "closed";
}

export function getLastError(): string | null {
  return lastError;
}

/** Timestamp (ms) of last successful payload, or 0 if none. For debug overlay. */
export function getLastMessageTime(): number {
  return lastMessageTime;
}

export function disposeSimClient(): void {
  disposed = true;
  if (retryTimeoutId != null) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  }
  clearClient();
  listeners = new Set();
  lastPayload = null;
  lastError = null;
  lastMessageTime = 0;
  retryDelayMs = INITIAL_RETRY_MS;
  currentViewFlyIndex = 0;
}
