/**
 * Robust WebSocket client for sim stream.
 * Single global connection. Incoming payloads are queued; display is ~1s behind (buffer of 4–5 × 250ms)
 * so we have headroom for network jitter. Listeners receive at 250ms rate from the front of the queue.
 */
import { getWsUrl } from "./wsUrl";
import type { FlyState } from "../../../api/src/fly-state";
import type { WorldSource } from "../../../api/src/world";

export type { FlyState };

export interface SimPayload {
  t?: number;
  /** Multi-fly: array of fly states */
  flies?: FlyState[];
  /** Legacy: single fly (prefer flies when present) */
  fly?: FlyState;
  activity?: Record<string, number>;
  /** Per-fly brain activity (index = sim index) */
  activities?: (Record<string, number> | undefined)[];
  simRunning?: boolean;
  sources?: WorldSource[];
  error?: string;
}

export type SimEvent = SimPayload | { _event: "open" } | { _event: "closed" } | { _event: "error"; error: string };
type Listener = (event: SimEvent) => void;

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;

/** Display ~1s behind: wait for this many payloads before starting the display tick. */
const BUFFER_SIZE_BEFORE_DISPLAY = 4;
const DISPLAY_TICK_MS = 250;
const QUEUE_MAX = 6;

let ws: WebSocket | null = null;
let listeners = new Set<Listener>();
let lastPayload: SimPayload | null = null;
let lastError: string | null = null;
let retryDelayMs = INITIAL_RETRY_MS;
let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
let displayTickId: ReturnType<typeof setInterval> | null = null;
let displayQueue: SimPayload[] = [];
let displayStarted = false;
/** Last payload we pushed to listeners (display state, ~1s behind); used for new subscribers. */
let lastDisplayPayload: SimPayload | null = null;
let disposed = false;
let deferredCleanup = false;

function stopDisplayTick(): void {
  if (displayTickId != null) {
    clearInterval(displayTickId);
    displayTickId = null;
  }
  displayStarted = false;
  displayQueue = [];
}

function startDisplayTick(): void {
  if (displayTickId != null) return;
  displayTickId = setInterval(() => {
    if (displayQueue.length === 0) return;
    const payload = displayQueue.shift()!;
    lastDisplayPayload = payload;
    for (const fn of listeners) fn(payload);
  }, DISPLAY_TICK_MS);
}

function doTeardown(): void {
  if (!ws) return;
  ws.onclose = null;
  ws.onerror = null;
  ws.onmessage = null;
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  ws = null;
  deferredCleanup = false;
}

function clearConnection(): void {
  if (!ws) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    deferredCleanup = true;
    return;
  }
  doTeardown();
}

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
    connect();
  }, delay);
}

function connect(): void {
  if (disposed || ws?.readyState === WebSocket.OPEN) return;
  // Don't abandon a handshaking socket; wait for it to finish (open/close) first
  if (ws?.readyState === WebSocket.CONNECTING) return;
  clearConnection();
  const url = getWsUrl();
  ws = new WebSocket(url);

  ws.onopen = () => {
    if (deferredCleanup) {
      doTeardown();
      return;
    }
    retryDelayMs = INITIAL_RETRY_MS;
    lastError = null;
    for (const fn of listeners) fn({ _event: "open" });
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string) as SimPayload;
      if (data.error) {
        lastError = data.error;
        for (const fn of listeners) fn(data as SimPayload);
        return;
      }
      lastError = null;
      lastPayload = data;
      if (displayQueue.length >= QUEUE_MAX) displayQueue.shift();
      displayQueue.push(data);
      if (!displayStarted && displayQueue.length >= BUFFER_SIZE_BEFORE_DISPLAY) {
        displayStarted = true;
        startDisplayTick();
      }
    } catch (err) {
      if (import.meta.env?.DEV) {
        console.warn("[simWsClient] parse error", err);
      }
    }
  };

  ws.onclose = () => {
    stopDisplayTick();
    for (const fn of listeners) fn({ _event: "closed" });
    deferredCleanup = false;
    doTeardown();
    if (listeners.size > 0 && !disposed) scheduleRestart();
  };

  ws.onerror = () => {
    const err = lastError ?? "Connection error";
    lastError = err;
    for (const fn of listeners) fn({ _event: "error", error: err });
  };
}

/**
 * Subscribe to sim payloads. Starts connection on first subscriber.
 * @returns Unsubscribe function.
 */
export function subscribeSim(listener: Listener): () => void {
  listeners.add(listener);
  if (ws?.readyState !== WebSocket.OPEN) connect();
  const initial = lastDisplayPayload ?? lastPayload;
  if (initial) {
    try {
      listener(initial);
    } catch {
      /* ignore */
    }
  }
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      listener({ _event: "open" });
    } catch {
      /* ignore */
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Send start message to start the sim. No-op if not connected. */
export function sendStart(): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "start" }));
  }
}

/** Send stop message to stop the sim. No-op if not connected. */
export function sendStop(): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
  }
}

export function getConnectionState(): "connecting" | "open" | "closed" {
  if (!ws) return "closed";
  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    default:
      return "closed";
  }
}

export function getLastError(): string | null {
  return lastError;
}

export function disposeSimClient(): void {
  disposed = true;
  if (retryTimeoutId != null) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  }
  stopDisplayTick();
  clearConnection();
  listeners = new Set();
  lastPayload = null;
  lastDisplayPayload = null;
  lastError = null;
  retryDelayMs = INITIAL_RETRY_MS;
}
