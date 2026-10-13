import { homedir } from "node:os";
import { join } from "node:path";
import { loopbackHostsFor } from "./security/origin.js";

export type ServerConfig = {
  host: string;
  port: number;
  databasePath: string;
  webDist: string | null;
  /** host:port values accepted on mutating requests: the API port plus the dev web port (Vite proxy). */
  allowedHosts: string[];
  /** SQLite WAL durability: NORMAL (default) or FULL (env DB_SYNCHRONOUS). */
  dbSynchronous: "NORMAL" | "FULL";
};

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

function parsePort(value: string, name: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== value.trim()) {
    throw new Error(`Invalid ${name} ${value}`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST ?? "127.0.0.1";
  // Local-only product: refuse wildcard or LAN binds.
  if (!LOOPBACK.has(host)) throw new Error(`HOST must be 127.0.0.1 or ::1, got ${host}`);
  const port = parsePort(env.API_PORT ?? env.PORT ?? "5512", "API_PORT");
  const ports = [port];
  if (env.WEB_PORT) ports.push(parsePort(env.WEB_PORT, "WEB_PORT"));
  const dataDir = env.DATA_DIR ?? join(homedir(), ".2048-infinite");
  return {
    host,
    port,
    databasePath: env.DATABASE_PATH ?? join(dataDir, "game.sqlite3"),
    webDist: env.WEB_DIST ?? null,
    allowedHosts: loopbackHostsFor(ports),
    dbSynchronous: parseSynchronous(env.DB_SYNCHRONOUS),
  };
}

function parseSynchronous(value: string | undefined): "NORMAL" | "FULL" {
  if (value === undefined || value === "") return "NORMAL";
  const upper = value.toUpperCase();
  if (upper === "NORMAL" || upper === "FULL") return upper;
  throw new Error(`DB_SYNCHRONOUS must be NORMAL or FULL, got ${value}`);
}
