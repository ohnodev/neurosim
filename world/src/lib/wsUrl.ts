/**
 * WebSocket URL for sim stream.
 * Uses shared getApiBase from constants.
 */
import { getApiBase } from "./constants.js";

export function getWsUrl(): string {
  const apiBase = getApiBase();
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}
