import { homedir } from "node:os";
import { join } from "node:path";

export type ServerConfig = {
  host: string;
  port: number;
  databasePath: string;
  webDist: string | null;
};

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST ?? "127.0.0.1";
  // Local-only product: refuse wildcard or LAN binds.
  if (!LOOPBACK.has(host)) throw new Error(`HOST must be 127.0.0.1 or ::1, got ${host}`);
  const port = Number.parseInt(env.API_PORT ?? env.PORT ?? "5512", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port ${env.API_PORT}`);
  const dataDir = env.DATA_DIR ?? join(homedir(), ".2048-infinite");
  return {
    host,
    port,
    databasePath: env.DATABASE_PATH ?? join(dataDir, "game.sqlite3"),
    webDist: env.WEB_DIST ?? null,
  };
}
