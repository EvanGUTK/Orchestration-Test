import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { API_BASE, LIMITS } from "@g2048/contracts";
import { DatabaseWriter, transactionSync } from "@g2048/database";
import { apiNotFound, installErrorHandling } from "./http/errors.js";
import { loggerOptions, type LogDestination } from "./http/logging.js";
import { installSecurityHooks, isApiRequest } from "./http/security-hooks.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { profileRoutes } from "./routes/profile.js";
import { PasswordHasher } from "./security/passwords.js";
import { AuthService } from "./services/auth-service.js";
import { EventBus } from "./services/event-bus.js";
import { GameService } from "./services/game-service.js";
import { gameRoutes } from "./routes/games.js";
import { competitionRoutes } from "./routes/competition.js";
import { BotRunService } from "./services/bot-run-service.js";
import { ChallengeService } from "./services/challenge-service.js";
import { LeaderboardService } from "./services/leaderboard-service.js";
import { ReplayService } from "./services/replay-service.js";
import { createBotServices, type BotServices } from "@g2048/bots/runner";
import type { Clock, ServiceContext } from "./services/context.js";

/**
 * HTTP timeouts (OPS-09): slow-loris clients are cut off promptly. Node checks pending requests every
 * `connectionsCheckingInterval`; incomplete headers after `headersTimeout`, an incomplete request after
 * `requestTimeout`; idle keep-alive sockets close after `keepAliveTimeout`, idle sockets after
 * `connectionTimeout` (upgraded WebSockets clear their own socket timeout).
 */
export const HTTP_TIMEOUTS = {
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  connectionTimeoutMs: 120_000,
  connectionsCheckingIntervalMs: 1_000,
} as const;

/** Requests slower than this are logged at warn level even when routine logging is at info. */
export const SLOW_REQUEST_MS = 1_000;

export type AppOptions = {
  db: DatabaseSync;
  webDist: string | null;
  logger?: boolean | { stream: LogDestination; level?: string };
  clock?: Clock;
  hasher?: PasswordHasher;
  /** Exact host:port values accepted for mutating requests; null = any loopback host. */
  allowedHosts?: readonly string[] | null;
  writerQueueMax?: number;
  loginAttemptsPerWindow?: number;
  loginWindowMs?: number;
  registrationsPerWindow?: number;
  guestsPerWindow?: number;
  maxGuests?: number;
  /** Session/guest purge interval; 0 disables the timer (it still runs once when the app is ready). */
  maintenanceIntervalMs?: number;
  /** Bot worker pool + runner; created once per app when omitted (shut down on close). */
  botServices?: BotServices;
};

/** Services exposed for feature plugins (ports/adapters): later tasks register routes against these. */
export type AppServices = {
  ctx: ServiceContext;
  auth: AuthService;
  games: GameService;
  events: EventBus;
  challenges: ChallengeService;
  leaderboards: LeaderboardService;
  replays: ReplayService;
  botRuns: BotRunService;
  bots: BotServices;
};

declare module "fastify" {
  interface FastifyInstance {
    services: AppServices;
  }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { db, webDist } = options;
  const app = Fastify({
    logger: loggerOptions(options.logger ?? false),
    bodyLimit: LIMITS.requestBodyBytes,
    requestTimeout: HTTP_TIMEOUTS.requestTimeoutMs,
    keepAliveTimeout: HTTP_TIMEOUTS.keepAliveTimeoutMs,
    connectionTimeout: HTTP_TIMEOUTS.connectionTimeoutMs,
    serverFactory: (handler) =>
      createServer(
        {
          headersTimeout: HTTP_TIMEOUTS.headersTimeoutMs,
          requestTimeout: HTTP_TIMEOUTS.requestTimeoutMs,
          keepAliveTimeout: HTTP_TIMEOUTS.keepAliveTimeoutMs,
          connectionsCheckingInterval: HTTP_TIMEOUTS.connectionsCheckingIntervalMs,
        },
        handler,
      ),
    genReqId: () => randomUUID(),
    trustProxy: false,
    // Per-request info lines cost more than the request itself (stdout pipes are synchronous on
    // Windows; OPS-03). Routine requests log at debug; errors and slow requests at warn (below).
    disableRequestLogging: true,
  });
  app.addHook("onResponse", async (request, reply) => {
    const ms = reply.elapsedTime;
    const entry = {
      reqId: request.id,
      method: request.method,
      url: request.url.split("?")[0],
      statusCode: reply.statusCode,
      ms,
    };
    if (reply.statusCode >= 500 || ms > SLOW_REQUEST_MS) request.log.warn(entry, "request completed");
    else request.log.debug(entry, "request completed");
  });

  const writer = new DatabaseWriter(db, { maxQueue: options.writerQueueMax ?? LIMITS.dbWriterQueueMax });
  const ctx: ServiceContext = { db, writer, clock: options.clock ?? (() => new Date()) };
  const auth = new AuthService(ctx, {
    hasher: options.hasher ?? new PasswordHasher(),
    ...(options.loginAttemptsPerWindow !== undefined
      ? { loginAttemptsPerWindow: options.loginAttemptsPerWindow }
      : {}),
    ...(options.loginWindowMs !== undefined ? { loginWindowMs: options.loginWindowMs } : {}),
    ...(options.registrationsPerWindow !== undefined
      ? { registrationsPerWindow: options.registrationsPerWindow }
      : {}),
    ...(options.guestsPerWindow !== undefined ? { guestsPerWindow: options.guestsPerWindow } : {}),
    ...(options.maxGuests !== undefined ? { maxGuests: options.maxGuests } : {}),
  });
  await auth.warmup();
  const events = new EventBus(writer);
  const games = new GameService(ctx, events);
  const challenges = new ChallengeService(ctx, games);
  const leaderboards = new LeaderboardService(ctx);
  const replays = new ReplayService(ctx, games);
  const bots = options.botServices ?? createBotServices();
  const botRuns = new BotRunService(ctx, games, bots, events);
  app.decorate("services", { ctx, auth, games, events, challenges, leaderboards, replays, botRuns, bots });

  // Housekeeping: purge expired/revoked sessions and orphaned guests at startup and periodically.
  const purge = async (): Promise<void> => {
    try {
      const purged = await auth.purgeInactive();
      if (purged.sessions + purged.guests > 0) app.log.info(purged, "purged inactive sessions/guests");
    } catch (error) {
      app.log.warn({ err: error }, "session purge failed");
    }
  };
  const intervalMs = options.maintenanceIntervalMs ?? 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    // Before any request: seed the season/challenge catalog and cancel bot runs a crash interrupted.
    // Direct transactions on the writer connection: nothing else runs before the server is ready.
    transactionSync(db, (tx) => challenges.ensureCatalogInTransaction(tx));
    const interrupted = transactionSync(db, (tx) => botRuns.recoverInterruptedInTransaction(tx));
    if (interrupted > 0) app.log.warn({ interrupted }, "bot runs interrupted by a restart were cancelled");
    await purge();
    if (intervalMs > 0) {
      timer = setInterval(() => void purge(), intervalMs);
      timer.unref();
    }
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await botRuns.shutdown(); // cancels runs and waits for their results to be persisted
    await writer.close();
  });

  installErrorHandling(app);
  await app.register(fastifyCookie);
  installSecurityHooks(app, auth, { allowedHosts: options.allowedHosts ?? null });

  await app.register(healthRoutes, { prefix: API_BASE, db });
  await app.register(authRoutes, { prefix: API_BASE, auth });
  await app.register(profileRoutes, { prefix: API_BASE, auth });
  await app.register(gameRoutes, { prefix: API_BASE, auth, games });
  await app.register(competitionRoutes, {
    prefix: API_BASE,
    auth,
    challenges,
    leaderboards,
    replays,
    botRuns,
  });

  const serveWeb = webDist !== null && existsSync(webDist);
  if (serveWeb) await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    // API paths always 404 as JSON; other paths fall back to the SPA entry when the UI is bundled.
    if (isApiRequest(request) || !serveWeb || request.method !== "GET") return apiNotFound(request, reply);
    return reply.sendFile("index.html");
  });
  return app;
}
