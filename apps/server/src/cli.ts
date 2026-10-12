import { resolve } from "node:path";
import { backupDatabase, migrate, openDatabase, restoreDatabase } from "@g2048/database";
import { loadConfig } from "./config.js";

const [command, argument] = process.argv.slice(2);
const { databasePath } = loadConfig();

async function run(): Promise<void> {
  switch (command) {
    case "migrate": {
      const db = openDatabase(databasePath);
      const applied = migrate(db);
      db.close();
      console.log(`Migrated ${databasePath}: applied [${applied.join(", ")}]`);
      return;
    }
    case "backup": {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const destination = resolve(argument ?? `${databasePath}.backup-${stamp}`);
      const db = openDatabase(databasePath);
      await backupDatabase(db, destination);
      db.close();
      console.log(`Backup written: ${destination}`);
      return;
    }
    case "restore": {
      if (!argument) throw new Error("Usage: npm run db:restore -- <backup-path>  (stop the server first)");
      restoreDatabase(resolve(argument), databasePath);
      console.log(`Restored ${databasePath} from ${resolve(argument)}`);
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
