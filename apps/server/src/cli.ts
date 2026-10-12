import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { backupDatabase, openDatabase, prepareDatabase, restoreDatabase } from "@g2048/database";
import { loadConfig } from "./config.js";
import { ownerResetPassword } from "./owner-reset.js";

/**
 * Local owner CLI (never exposed over HTTP):
 *   migrate                 apply pending migrations (preflight backup when upgrading)
 *   backup [destination]    online, WAL-safe backup through the SQLite backup API
 *   restore <backup-path>   validated offline restore; refuses while the server runs
 *   reset-password <user>   owner password reset; the new password is read from stdin
 *                           (prompted twice without echo on a terminal), never from argv
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
    case "reset-password": {
      if (!argument) throw new Error("Usage: cli reset-password <username>  (new password read from stdin)");
      const password = await readNewPassword();
      const { revokedSessions } = await ownerResetPassword(databasePath, argument, password);
      console.log(`Password reset for ${argument}; revoked ${revokedSessions} session(s)`);
      return;
    }
    default:
      throw new Error(
        `Unknown command ${command ?? "(none)"}; expected migrate | backup | restore | reset-password`,
      );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function promptHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const muted = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    return await new Promise<string>((resolveLine) => rl.question("", resolveLine));
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

/** First line of piped stdin, or a no-echo prompt (twice) on a terminal. */
async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return (await readStdin()).split(/\r?\n/)[0] ?? "";
  const first = await promptHidden("New password: ");
  const second = await promptHidden("Repeat new password: ");
  if (first !== second) throw new Error("Passwords do not match");
  return first;
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
