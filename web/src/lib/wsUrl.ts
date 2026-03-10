/**
 * WebSocket URL for sim stream.
 * localhost → ws://localhost:3999/ws
 * production → wss://api.neurosim.fun/ws
 */
const isLocal =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

export function getWsUrl(): string {
  const apiBase = isLocal ? "http://localhost:3999" : "https://api.neurosim.fun";
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}
