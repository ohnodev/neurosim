/**
 * WebSocket URL for sim stream.
 * localhost → ws://localhost:3001/ws
 * production → VITE_API_BASE or https://api.neurosim.fun
 */
const isLocal =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

export function getApiBase(): string {
  if (isLocal) return "http://localhost:3001";
  const raw = typeof import.meta !== "undefined" && (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE;
  const trimmedOverride = typeof raw === "string" ? raw.trim() : "";
  return trimmedOverride ? trimmedOverride.replace(/\/$/, "") : "https://api.neurosim.fun";
}

export function getWsUrl(): string {
  const apiBase = getApiBase();
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}
