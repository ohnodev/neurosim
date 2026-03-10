/**
 * WebSocket URL for sim stream.
 * Local: ws://localhost:3001/ws
 * Prod: wss://... (from VITE_WS_URL or derived from VITE_API_URL).
 */
const isLocal =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

const wsUrlFromEnv = (import.meta.env.VITE_WS_URL as string | undefined)?.trim();
const apiUrlFromEnv = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

export function getWsUrl(): string {
  if (wsUrlFromEnv && wsUrlFromEnv.length > 0) return wsUrlFromEnv;
  const apiBase =
    apiUrlFromEnv && apiUrlFromEnv.length > 0
      ? apiUrlFromEnv
      : isLocal
        ? "http://localhost:3001"
        : window.location.origin;
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = url.pathname.replace(/\/+$/, "") || "/";
  url.pathname = basePath + (basePath.endsWith("/") ? "" : "/") + "ws";
  url.pathname = url.pathname.replace(/\/+/g, "/");
  return url.toString();
}
