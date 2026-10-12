// M0 skeleton created by chief; owned by the backend lane from CONTRACT-001 onward.
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type Migration = { version: number; name: string; sql: string };

/** Ordered, append-only. Never edit an applied migration; add a new version. */
export const MIGRATIONS: readonly Migration[] = [];

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Applies pending migrations in one transaction each; verifies checksums of applied ones. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Map(
    (
      db.prepare("SELECT version, checksum FROM schema_migrations").all() as {
        version: number;
        checksum: string;
      }[]
    ).map((r) => [r.version, r.checksum]),
  );
  const done: number[] = [];
  for (const m of migrations) {
    const sum = checksum(m.sql);
    const prior = applied.get(m.version);
    if (prior !== undefined) {
      if (prior !== sum) throw new Error(`Migration ${m.version} checksum changed after it was applied`);
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(m.version, m.name, sum, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    done.push(m.version);
  }
  return done;
}

/** WAL-safe online backup through the SQLite backup API. */
export async function backupDatabase(db: DatabaseSync, destination: string): Promise<void> {
  if (existsSync(destination)) throw new Error(`Backup destination already exists: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  await sqliteBackup(db, destination);
}

/** Validates a backup, then replaces the target. The application must be stopped. */
export function restoreDatabase(source: string, target: string): void {
  if (!existsSync(source)) throw new Error(`Backup not found: ${source}`);
  const candidate = new DatabaseSync(source, { readOnly: true });
  try {
    const row = candidate.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (row.integrity_check !== "ok")
      throw new Error(`Backup failed integrity check: ${row.integrity_check}`);
    const hasMigrations = candidate
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (!hasMigrations) throw new Error("Backup is not a 2048 Infinite database (no schema_migrations)");
  } finally {
    candidate.close();
  }
  mkdirSync(dirname(target), { recursive: true });
  const staged = `${target}.restore-tmp`;
  copyFileSync(source, staged);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
  copyFileSync(staged, target);
  rmSync(staged, { force: true });
}
