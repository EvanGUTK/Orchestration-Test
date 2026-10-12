import { resolve } from "node:path";
import { GameDb } from "./connection.ts";
import { backupDatabase, defaultBackupPath, restoreDatabase } from "./backup.ts";
import { migrate, pendingMigrations } from "./migrate.ts";
import { MigrationError, RestoreError } from "./errors.ts";

const USAGE = `Usage: node packages/database/src/cli.ts <command> [args]

  migrate                 apply pending migrations to $DATABASE_PATH (creates the file if missing)
  backup [dest]           consistent online backup (SQLite backup API); default dest: <db dir>/backups/
  restore <backup-file>   validate <backup-file>, then replace $DATABASE_PATH (STOP the server first;
                          the previous database is kept as <db dir>/backups/pre-restore-*.sqlite3)

Environment: DATABASE_PATH (required unless set via .lab/env.sh)`;

type Io = { out: (s: string) => void; err: (s: string) => void };

export async function runCli(argv: readonly string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
  const [command, ...rest] = argv;
  const databasePath = env.DATABASE_PATH;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  if (!databasePath) {
    io.err("DATABASE_PATH is not set (source .lab/env.sh)");
    return 2;
  }
  const active = resolve(databasePath);
  try {
    switch (command) {
      case "migrate": {
        const db = GameDb.open(active);
        try {
          const before = pendingMigrations(db.raw).length;
          const report = migrate(db.raw);
          io.out(
            before === 0
              ? `Database ${active} is up to date at schema version ${report.currentVersion}.`
              : `Applied migrations [${report.applied.join(", ")}]; ${active} is now at schema version ${report.currentVersion}.`,
          );
        } finally {
          db.close();
        }
        return 0;
      }
      case "backup": {
        const db = GameDb.open(active, { readonly: false });
        try {
          const dest = rest[0] ? resolve(rest[0]) : defaultBackupPath(active);
          const r = await backupDatabase(db.raw, dest);
          io.out(`Backup written: ${r.path} (${r.bytes} bytes, sha256 ${r.sha256}, ${r.migrations} migrations)`);
        } finally {
          db.close();
        }
        return 0;
      }
      case "restore": {
        const src = rest[0];
        if (!src) {
          io.err("restore requires a backup file path: npm run db:restore -- <path>");
          return 2;
        }
        const r = await restoreDatabase(src, active);
        io.out(`Restored ${r.restoredFrom} -> ${r.activePath} (${r.migrations} migrations).`);
        if (r.preRestoreBackup) io.out(`Previous database preserved at ${r.preRestoreBackup}`);
        return 0;
      }
      default:
        io.err(`Unknown command: ${command}\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof RestoreError) {
      io.err(
        `Restore refused (${err.code}): ${err.message}` +
          (err.code === "RESTORE_FAILED" ? "\nCheck the pre-restore backup in the backups directory." : "\nThe active database was not modified."),
      );
      return 1;
    }
    if (err instanceof MigrationError) {
      io.err(`Migration error (${err.code}): ${err.message}`);
      return 1;
    }
    io.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2), process.env, {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  }).then((code) => {
    process.exitCode = code;
  });
}
