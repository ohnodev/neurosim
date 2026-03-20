/**
 * WebSocket URL for sim stream.
 * Uses shared getApiBase from constants.
 */
import { getApiBase } from "./constants.js";

export function getWsUrl(): string {
  const apiBase = getApiBase();
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Single GraphQL websocket endpoint.
  url.pathname = "/graphql-ws";
  return url.toString();
}
