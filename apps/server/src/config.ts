import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ServerConfig = {
  /** Always a loopback address. */
  host: string;
  port: number;
  webPort: number;
  databasePath: string;
  /** Absolute path of the built web client, or null when it does not exist. */
  webDist: string | null;
  cookieSecure: boolean;
  sessionTtlMs: number;
  /** Request body cap in bytes for ordinary JSON routes. */
  bodyLimit: number;
  /** Extra allowed browser origins (exact match), e.g. a dev server on another port. */
  extraOrigins: string[];
  argon2: { memoryCost: number; timeCost: number; parallelism: number };
  limits: {
    loginFailuresPerUser: number;
    loginFailuresPerIp: number;
    failureWindowMs: number;
    registrationsPerIp: number;
    registrationWindowMs: number;
    guestsPerIp: number;
    /** Global per-IP requests per minute (flood guard). */
    requestsPerMinute: number;
    maxActiveGamesPerOwner: number;
    writeQueueMax: number;
  };
  logLevel: string;
};

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

function int(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} must be between ${min} and ${max}`);
  return n;
}

export function defaultWebDist(): string | null {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  return existsSync(resolve(dist, "index.html")) ? dist : null;
}

/** Parse environment into a validated config. Throws on a non-loopback HOST: LAN/public binding is out of scope. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const host = env.HOST && env.HOST !== "" ? env.HOST : "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`HOST must be a loopback address (127.0.0.1 or ::1), got ${JSON.stringify(host)}`);
  }
  return {
    host,
    port: int(env, "API_PORT", 5511, 0, 65535),
    webPort: int(env, "WEB_PORT", 5411, 0, 65535),
    databasePath: resolve(env.DATABASE_PATH && env.DATABASE_PATH !== "" ? env.DATABASE_PATH : "data/game.sqlite3"),
    webDist: env.WEB_DIST === "" ? null : env.WEB_DIST ? resolve(env.WEB_DIST) : defaultWebDist(),
    cookieSecure: env.COOKIE_SECURE === "1",
    sessionTtlMs: int(env, "SESSION_TTL_HOURS", 24 * 30, 1, 24 * 365) * 3_600_000,
    bodyLimit: int(env, "BODY_LIMIT_BYTES", 64 * 1024, 1024, 8 * 1024 * 1024),
    extraOrigins: (env.EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // OWASP Argon2id minimum profile (19 MiB, t=2, p=1); override only for tests.
    argon2: {
      memoryCost: int(env, "ARGON2_MEMORY_KIB", 19456, 8, 1_048_576),
      timeCost: int(env, "ARGON2_TIME_COST", 2, 1, 20),
      parallelism: int(env, "ARGON2_PARALLELISM", 1, 1, 16),
    },
    limits: {
      loginFailuresPerUser: int(env, "LOGIN_FAILURES_PER_USER", 10, 1, 10_000),
      loginFailuresPerIp: int(env, "LOGIN_FAILURES_PER_IP", 100, 1, 100_000),
      failureWindowMs: int(env, "FAILURE_WINDOW_SECONDS", 600, 1, 86_400) * 1000,
      registrationsPerIp: int(env, "REGISTRATIONS_PER_IP", 50, 1, 100_000),
      registrationWindowMs: int(env, "REGISTRATION_WINDOW_SECONDS", 600, 1, 86_400) * 1000,
      guestsPerIp: int(env, "GUESTS_PER_IP", 200, 1, 100_000),
      requestsPerMinute: int(env, "REQUESTS_PER_MINUTE", 60_000, 10, 10_000_000),
      maxActiveGamesPerOwner: int(env, "MAX_ACTIVE_GAMES", 100, 1, 100_000),
      writeQueueMax: int(env, "WRITE_QUEUE_MAX", 512, 1, 100_000),
    },
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

/** Hosts and origins the API trusts (DNS-rebinding and cross-site defence for a loopback-only app). */
export function trustedHosts(config: Pick<ServerConfig, "port" | "webPort">, boundPort = config.port): Set<string> {
  const hosts = new Set<string>();
  for (const p of new Set([boundPort, config.port, config.webPort])) {
    if (!p) continue;
    hosts.add(`127.0.0.1:${p}`);
    hosts.add(`localhost:${p}`);
    hosts.add(`[::1]:${p}`);
  }
  return hosts;
}
