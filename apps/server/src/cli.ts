import { resolve } from "node:path";
import { backupDatabase, openDatabase, prepareDatabase, restoreDatabase } from "@g2048/database";
import { loadConfig } from "./config.js";

/**
 * Local owner CLI (never exposed over HTTP):
 *   migrate                 apply pending migrations (preflight backup when upgrading)
 *   backup [destination]    online, WAL-safe backup through the SQLite backup API
 *   restore <backup-path>   validated offline restore; refuses while the server runs
 */
const [command, argument] = process.argv.slice(2);
const { databasePath } = loadConfig();

async function run(): Promise<void> {
  switch (command) {
    case "migrate": {
      const { db, applied, preflightBackup } = await prepareDatabase(databasePath);
      db.close();
      if (preflightBackup) console.log(`Preflight backup: ${preflightBackup}`);
      console.log(`Migrated ${databasePath}: applied [${applied.join(", ")}]`);
      return;
    }
    case "backup": {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const destination = resolve(argument ?? `${databasePath}.backup-${stamp}`);
      const db = openDatabase(databasePath);
      try {
        await backupDatabase(db, destination);
      } finally {
        db.close();
      }
      console.log(`Backup written: ${destination}`);
      return;
    }
    case "restore": {
      if (!argument) throw new Error("Usage: npm run db:restore -- <backup-path>  (stop the server first)");
      const result = await restoreDatabase(resolve(argument), databasePath);
      if (result.safetyBackup) console.log(`Previous database saved as: ${result.safetyBackup}`);
      console.log(`Restored ${databasePath} from ${result.restoredFrom}`);
      if (result.report.pendingMigrations.length > 0) {
        console.log(
          `Migrations [${result.report.pendingMigrations.join(", ")}] will apply on next start/db:migrate`,
        );
      }
      return;
    }
    default:
      throw new Error(`Unknown command ${command ?? "(none)"}; expected migrate | backup | restore`);
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
