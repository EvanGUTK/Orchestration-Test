import type { FastifyInstance } from "fastify";
import { DomainError, type HealthResponse, type ReadyResponse } from "@2048/contracts";
import { readAppliedMigrations } from "@2048/database";
import type { AppServices } from "../app.ts";

export function registerSystemRoutes(app: FastifyInstance, s: AppServices): void {
  app.get("/health", async (): Promise<HealthResponse> => ({ status: "ok" }));

  app.get("/ready", async (): Promise<ReadyResponse> => {
    try {
      const rows = s.db.read((raw) => {
        raw.prepare("SELECT 1").get();
        return readAppliedMigrations(raw);
      });
      if (rows.length === 0) throw new Error("no migrations applied");
      return { status: "ready", schemaVersion: rows.length, migrations: rows.length };
    } catch {
      throw new DomainError("DB_BUSY", "Database is not ready");
    }
  });
}
