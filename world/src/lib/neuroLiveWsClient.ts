import { createClient, type Client } from "graphql-ws";
import { getWsUrl } from "./wsUrl";

export type LiveReplayTick = {
  tick: number;
  time_sec: number;
  spikes: string[];
};

export type NeuroLiveEvent =
  | {
      type: "status";
      latestTick: number;
      dtSec: number;
      penALeftHz: number;
      penARightHz: number;
      ratesById?: Record<string, number> | null;
    }
  | {
      type: "ticks";
      ticks: LiveReplayTick[];
      latestTick: number;
      dtSec: number;
    }
  | {
      type: "error";
      error: string;
    };

type Listener = (event: NeuroLiveEvent) => void;

const SUBSCRIPTION = `
  subscription NeurosimLive($fromTick: Int, $maxTicks: Int) {
    neurosimLive(fromTick: $fromTick, maxTicks: $maxTicks)
  }
`;

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;

let client: Client | null = null;
let listeners = new Set<Listener>();
let retryDelayMs = INITIAL_RETRY_MS;
let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
let teardownTimeoutId: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let subscriptionStarted = false;
let runId = 0;
let lastDeliveredTick = -1;

function clearClient(): void {
  const activeClient = client;
  client = null;
  subscriptionStarted = false;
  if (!activeClient) return;
  try {
    const disposeResult = activeClient.dispose();
    if (disposeResult && typeof (disposeResult as Promise<void>).catch === "function") {
      (disposeResult as Promise<void>).catch(() => {
        /* ignore */
      });
    }
  } catch {
    /* ignore */
  }
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const s = String(err);
  if (s === "[object Event]" || s === "[object Object]") return "Connection error";
  return s || "Connection error";
}

function emit(event: NeuroLiveEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

function scheduleRestart(): void {
  if (retryTimeoutId != null || disposed) return;
  const jitter = retryDelayMs * 0.2 * (Math.random() - 0.5);
  const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(INITIAL_RETRY_MS, Math.floor(retryDelayMs + jitter)));
  retryTimeoutId = setTimeout(() => {
    retryTimeoutId = null;
    retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * BACKOFF_FACTOR);
    startSubscription();
  }, delay);
}

function startSubscription(): void {
  if (disposed || listeners.size === 0 || subscriptionStarted) return;
  subscriptionStarted = true;
  const currentRunId = ++runId;
  client = createClient({
    url: getWsUrl(),
    on: {
      connected: () => {
        retryDelayMs = INITIAL_RETRY_MS;
      },
      error: (error) => {
        emit({ type: "error", error: toErrorMessage(error) });
      },
    },
  });

  const iterator = client.iterate({
    query: SUBSCRIPTION,
    variables: {
      maxTicks: 2000,
      ...(lastDeliveredTick >= 0 ? { fromTick: lastDeliveredTick + 1 } : {}),
    },
  });

  (async () => {
    try {
      for await (const result of iterator) {
        if (result.errors?.length) {
          emit({ type: "error", error: result.errors.map((e) => e.message).join("; ") || "Subscription error" });
          continue;
        }
        const raw = (result.data as { neurosimLive?: string } | undefined)?.neurosimLive;
        if (typeof raw !== "string") continue;
        const payload = JSON.parse(raw) as NeuroLiveEvent;
        emit(payload);
        if (payload.type === "ticks" && Array.isArray(payload.ticks) && payload.ticks.length > 0) {
          const highestTick = payload.ticks[payload.ticks.length - 1]?.tick;
          if (typeof highestTick === "number" && Number.isFinite(highestTick)) {
            lastDeliveredTick = Math.max(lastDeliveredTick, highestTick);
          }
        }
      }
    } catch (err) {
      emit({ type: "error", error: toErrorMessage(err) });
    } finally {
      if (currentRunId === runId) {
        clearClient();
        if (listeners.size > 0 && !disposed) scheduleRestart();
      }
    }
  })();
}

export function subscribeNeuroLive(listener: Listener): () => void {
  if (teardownTimeoutId != null) {
    clearTimeout(teardownTimeoutId);
    teardownTimeoutId = null;
  }
  listeners.add(listener);
  startSubscription();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardownTimeoutId = setTimeout(() => {
        teardownTimeoutId = null;
        if (listeners.size === 0) clearClient();
      }, 100);
    }
  };
}

export function disposeNeuroLiveClient(): void {
  disposed = true;
  if (teardownTimeoutId != null) {
    clearTimeout(teardownTimeoutId);
    teardownTimeoutId = null;
  }
  if (retryTimeoutId != null) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  }
  clearClient();
  listeners = new Set();
  retryDelayMs = INITIAL_RETRY_MS;
  lastDeliveredTick = -1;
}
