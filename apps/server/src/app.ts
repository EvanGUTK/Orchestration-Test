import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { API_BASE, DomainError, ERROR_HTTP_STATUS, type ErrorCode } from "@2048/contracts";
import { LATEST_SCHEMA_VERSION, WriteQueue, mapSqliteError, type GameDb } from "@2048/database";
import { trustedHosts, type ServerConfig } from "./config.ts";
import { envelope, forbidden, unauthenticated } from "./errors.ts";
import { AccountService, csrfMatches, type Principal } from "./services/accounts.ts";
import { GameService } from "./services/games.ts";
import { PasswordHasher } from "./services/passwords.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerGameRoutes } from "./routes/games.ts";
import { registerSystemRoutes } from "./routes/system.ts";

export const SESSION_COOKIE = "sid";
export const GUEST_COOKIE = "gsid";

export type AppServices = {
  db: GameDb;
  queue: WriteQueue;
  config: ServerConfig;
  accounts: AccountService;
  games: GameService;
};

export type BuildOptions = {
  db: GameDb;
  config: ServerConfig;
  logger?: boolean | { level: string };
  /** Port actually bound (config.port may be 0 in tests). */
  boundPort?: () => number;
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const API_PREFIX = API_BASE;

/** Per-request resolved principals (set lazily by `principalOf`). */
const principals = new WeakMap<FastifyRequest, { user: Principal | null; guest: Principal | null }>();

export function principalsOf(app: AppServices, req: FastifyRequest): { user: Principal | null; guest: Principal | null } {
  let p = principals.get(req);
  if (!p) {
    p = {
      user: app.accounts.resolve(req.cookies[SESSION_COOKIE], "user"),
      guest: app.accounts.resolve(req.cookies[GUEST_COOKIE], "guest"),
    };
    principals.set(req, p);
  }
  return p;
}

/**
 * Require an authenticated principal (a registered user wins over a guest). For mutating methods the
 * session-bound CSRF token must be presented in `x-csrf-token`.
 */
export function requirePrincipal(app: AppServices, req: FastifyRequest, opts: { userOnly?: boolean } = {}): Principal {
  const { user, guest } = principalsOf(app, req);
  const p = user ?? (opts.userOnly ? null : guest);
  if (!p) {
    if (opts.userOnly && guest) throw forbidden("This action requires a registered account");
    throw unauthenticated();
  }
  if (MUTATING.has(req.method)) {
    const header = req.headers["x-csrf-token"];
    if (!csrfMatches(p.token, typeof header === "string" ? header : undefined)) {
      throw forbidden("Missing or invalid CSRF token");
    }
  }
  return p;
}

export function setSessionCookie(app: AppServices, reply: FastifyReply, kind: "user" | "guest", token: string, maxAgeSec: number): void {
  void reply.setCookie(kind === "user" ? SESSION_COOKIE : GUEST_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: app.config.cookieSecure,
    path: "/",
    maxAge: maxAgeSec,
  });
}

export function clearSessionCookie(app: AppServices, reply: FastifyReply, kind: "user" | "guest"): void {
  void reply.clearCookie(kind === "user" ? SESSION_COOKIE : GUEST_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: app.config.cookieSecure,
    path: "/",
  });
}

function statusForFastifyError(err: FastifyError): { status: number; code: ErrorCode; message: string } {
  const status = typeof err.statusCode === "number" ? err.statusCode : 500;
  if (status === 413) return { status, code: "VALIDATION_ERROR", message: "Request body is too large" };
  if (status === 415) return { status, code: "VALIDATION_ERROR", message: "Content-Type must be application/json" };
  if (status === 429) return { status, code: "RATE_LIMITED", message: "Too many requests; slow down" };
  if (status >= 400 && status < 500) return { status: 400, code: "VALIDATION_ERROR", message: "Malformed request" };
  return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}

export async function buildApp(options: BuildOptions): Promise<{ app: FastifyInstance; services: AppServices }> {
  const { db, config } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: config.bodyLimit,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    // Reject pathological URLs early; this is a local single-user server.
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 200 },
  });

  const queue = new WriteQueue(db, { maxPending: config.limits.writeQueueMax });
  const hasher = new PasswordHasher(config.argon2);
  const accounts = new AccountService({ db, queue, config, hasher });
  const games = new GameService({ db, queue, config });
  const services: AppServices = { db, queue, config, accounts, games };

  const trusted = () => trustedHosts(config, options.boundPort?.() ?? config.port);
  const trustedOrigin = (origin: string): boolean => {
    if (config.extraOrigins.includes(origin)) return true;
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    return u.protocol === "http:" && u.origin === origin && trusted().has(u.host);
  };

  await app.register(fastifyCookie);

  // JSON-only bodies. An empty body is `{}` so bodyless POSTs with a JSON content type work.
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: config.bodyLimit }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }), undefined);
    }
  });

  await app.register(fastifyRateLimit, {
    global: true,
    max: config.limits.requestsPerMinute,
    timeWindow: "1 minute",
    hook: "onRequest",
    errorResponseBuilder: (_req, ctx) =>
      new DomainError("RATE_LIMITED", "Too many requests; slow down", { retryAfterSec: Math.ceil(ctx.ttl / 1000) }),
  });

  // Host allow-list (DNS rebinding) + Origin/Sec-Fetch-Site checks on state-changing requests.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    if (req.url.startsWith(API_PREFIX) || req.url === "/health" || req.url === "/ready") {
      reply.header("cache-control", "no-store");
    }
    const host = req.headers.host;
    if (!host || !trusted().has(host.toLowerCase())) throw forbidden("Untrusted Host header");
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (typeof origin !== "string" || !trustedOrigin(origin)) throw forbidden("Cross-origin request rejected");
      } else {
        const site = req.headers["sec-fetch-site"];
        if (site !== undefined && site !== "same-origin" && site !== "none") throw forbidden("Cross-site request rejected");
      }
    }
  });

  app.setErrorHandler((err: FastifyError | DomainError, req, reply) => {
    const mapped = err instanceof DomainError ? err : mapSqliteError(err);
    if (mapped instanceof DomainError) {
      const status = ERROR_HTTP_STATUS[mapped.code];
      if (mapped.code === "RATE_LIMITED") {
        const secs = (mapped.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
        if (secs) void reply.header("retry-after", String(secs));
      }
      if (mapped.code === "DB_BUSY" || mapped.code === "RESOURCE_LIMIT") void reply.header("retry-after", "1");
      if (mapped.code === "INTERNAL_ERROR") req.log.error({ err: mapped }, "internal error");
      return reply.status(status).send(envelope(mapped.code, mapped.message, req.id, mapped.details));
    }
    const f = statusForFastifyError(err as FastifyError);
    if (f.status >= 500) req.log.error({ err }, "unhandled error");
    return reply.status(f.status).send(envelope(f.code, f.message, req.id));
  });

  const webDist = config.webDist && existsSync(resolve(config.webDist, "index.html")) ? config.webDist : null;
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, index: ["index.html"], wildcard: true, cacheControl: true, maxAge: "1h", immutable: false });
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith(API_PREFIX) || req.url === "/health" || req.url === "/ready";
    if (webDist && !isApi && (req.method === "GET" || req.method === "HEAD") && (req.headers.accept ?? "").includes("text/html")) {
      void reply.header("content-security-policy", CSP).header("cache-control", "no-cache");
      return reply.sendFile("index.html");
    }
    return reply.status(404).send(envelope("NOT_FOUND", "Not found", req.id));
  });

  if (webDist) {
    app.addHook("onSend", async (req, reply, payload) => {
      const type = String(reply.getHeader("content-type") ?? "");
      if (type.startsWith("text/html") && !req.url.startsWith(API_PREFIX)) reply.header("content-security-policy", CSP);
      return payload;
    });
  }

  await app.register(
    async (api) => {
      registerSystemRoutes(api, services);
      registerAuthRoutes(api, services);
      registerGameRoutes(api, services);
    },
    { prefix: API_PREFIX },
  );
  // Unprefixed liveness/readiness aliases for scripts and process supervisors.
  registerSystemRoutes(app, services);

  const purge = setInterval(() => {
    try {
      accounts.purgeExpiredSessions();
    } catch {
      /* best effort housekeeping */
    }
  }, 3_600_000);
  purge.unref();
  app.addHook("onClose", async () => clearInterval(purge));

  return { app, services };
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export { LATEST_SCHEMA_VERSION };
