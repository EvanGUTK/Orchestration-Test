import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { API_BASE, LIMITS } from "@g2048/contracts";
import { DatabaseWriter } from "@g2048/database";
import { apiNotFound, installErrorHandling, isApiPath } from "./http/errors.js";
import { loggerOptions, type LogDestination } from "./http/logging.js";
import { installSecurityHooks } from "./http/security-hooks.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { profileRoutes } from "./routes/profile.js";
import { PasswordHasher } from "./security/passwords.js";
import { AuthService } from "./services/auth-service.js";
import type { Clock, ServiceContext } from "./services/context.js";

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
};

/** Services exposed for feature plugins (ports/adapters): later tasks register routes against these. */
export type AppServices = { ctx: ServiceContext; auth: AuthService };

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
    requestTimeout: 30_000,
    genReqId: () => randomUUID(),
    trustProxy: false,
  });

  const writer = new DatabaseWriter(db, { maxQueue: options.writerQueueMax ?? LIMITS.dbWriterQueueMax });
  const ctx: ServiceContext = { db, writer, clock: options.clock ?? (() => new Date()) };
  const auth = new AuthService(ctx, {
    hasher: options.hasher ?? new PasswordHasher(),
    ...(options.loginAttemptsPerWindow !== undefined
      ? { loginAttemptsPerWindow: options.loginAttemptsPerWindow }
      : {}),
    ...(options.loginWindowMs !== undefined ? { loginWindowMs: options.loginWindowMs } : {}),
  });
  app.decorate("services", { ctx, auth });
  app.addHook("onClose", async () => {
    await writer.close();
  });

  installErrorHandling(app);
  await app.register(fastifyCookie);
  installSecurityHooks(app, auth, { allowedHosts: options.allowedHosts ?? null });

  await app.register(healthRoutes, { prefix: API_BASE, db });
  await app.register(authRoutes, { prefix: API_BASE, auth });
  await app.register(profileRoutes, { prefix: API_BASE, auth });

  const serveWeb = webDist !== null && existsSync(webDist);
  if (serveWeb) await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    // API paths always 404 as JSON; other paths fall back to the SPA entry when the UI is bundled.
    if (isApiPath(request.url) || !serveWeb || request.method !== "GET") return apiNotFound(request, reply);
    return reply.sendFile("index.html");
  });
  return app;
}
