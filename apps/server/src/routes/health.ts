import type { FastifyPluginAsync } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "@g2048/contracts";
import { inspectMigrations, MIGRATIONS } from "@g2048/database";

export type HealthRoutesOptions = { db: DatabaseSync };

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, { db }) => {
  app.get("/health", async () => ({ status: "ok" }));

  /** Ready only when every migration of this build is applied and the database answers. */
  app.get("/ready", async (_request, reply) => {
    try {
      const status = inspectMigrations(db, MIGRATIONS);
      if (status.pending.length > 0 || status.unknown.length > 0 || status.mismatched.length > 0) {
        return reply.code(503).send({ status: "not-ready" });
      }
      return { status: "ready", schemaVersion: SCHEMA_VERSION, migrations: status.applied.length };
    } catch {
      return reply.code(503).send({ status: "not-ready" });
    }
  });
};
