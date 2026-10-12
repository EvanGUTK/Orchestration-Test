// M0 skeleton created by chief; owned by the backend lane from CONTRACT-001 onward.
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { API_BASE, SCHEMA_VERSION } from "@g2048/contracts";

export type AppOptions = { db: DatabaseSync; webDist: string | null; logger?: boolean };

export async function buildApp({ db, webDist, logger = false }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });

  app.get(`${API_BASE}/health`, async () => ({ status: "ok" }));
  app.get(`${API_BASE}/ready`, async (_request, reply) => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number } | undefined;
    if (!row) return reply.code(503).send({ status: "not-ready" });
    return { status: "ready", schemaVersion: SCHEMA_VERSION, migrations: row.n };
  });

  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // SPA fallback for client routes; API paths still 404 as JSON.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith(API_BASE)) {
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: "Not found", requestId: request.id } });
      }
      return reply.sendFile("index.html");
    });
  }
  return app;
}
