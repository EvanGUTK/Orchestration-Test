import { fileURLToPath } from "node:url";
import { acquireDatabaseLock, prepareDatabase, type PreparedDatabase } from "@g2048/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
// Owner lock first: offline restore refuses while this process holds the database.
const releaseLock = acquireDatabaseLock(config.databasePath);
let prepared: PreparedDatabase;
try {
  // Pending migrations apply (with a preflight backup) before any request is accepted.
  prepared = await prepareDatabase(config.databasePath);
} catch (error) {
  releaseLock();
  console.error(
    `Database startup failed; prior data left intact: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const { db } = prepared;
const webDist = config.webDist ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = await buildApp({ db, webDist, logger: true, allowedHosts: config.allowedHosts });
// Restart recovery: every resumable game is rebuilt from its nearest snapshot + move log and compared
// with the saved state before requests are accepted. Failures are surfaced, never silently repaired.
const reports = app.services.games.verifyActiveGames();
const broken = reports.filter((r) => !r.ok);
app.log.info({ verified: reports.length, failed: broken.length }, "resumable game integrity check");
for (const report of broken) app.log.error({ integrity: report }, "game failed integrity verification");
await app.listen({ host: config.host, port: config.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      db.close();
      releaseLock();
      process.exit(0);
    });
  });
}
