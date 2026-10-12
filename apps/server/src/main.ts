import { GameDb, migrate } from "@2048/database";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

/** Boot order: config -> open DB -> apply migrations -> verify integrity -> listen (never before migrations). */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = GameDb.open(config.databasePath);
  let report;
  try {
    report = migrate(db.raw);
    const integrity = db.integrityCheck();
    if (integrity.length !== 1 || integrity[0] !== "ok") {
      throw new Error(`database integrity check failed: ${integrity.slice(0, 3).join("; ")}`);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  const { app } = await buildApp({ db, config, logger: { level: config.logLevel } });
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
    } finally {
      db.close();
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { host: config.host, port: config.port, schemaVersion: report.currentVersion, database: config.databasePath, web: config.webDist ?? "none" },
    "2048 server listening on loopback",
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
