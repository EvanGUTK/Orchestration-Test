import { createHash } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { MigrationError } from "./errors.ts";
import { MIGRATIONS, type Migration } from "./migrations/index.ts";

export type MigrationReport = {
  applied: number[];
  currentVersion: number;
  total: number;
};

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT`;

export type AppliedMigration = { version: number; name: string; checksum: string; applied_at: string };

export function readAppliedMigrations(db: SqliteDatabase): AppliedMigration[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return [];
  return db.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all() as AppliedMigration[];
}

/** Verify applied rows against the known list: no unknown/newer versions, no gaps, matching checksums. */
export function verifyAppliedMigrations(applied: readonly AppliedMigration[], known: readonly Migration[] = MIGRATIONS): void {
  const byVersion = new Map(known.map((m) => [m.version, m]));
  applied.forEach((row, index) => {
    const m = byVersion.get(row.version);
    if (!m) {
      throw new MigrationError(
        "MIGRATION_UNKNOWN_VERSION",
        `Database has migration ${row.version} (${row.name}) that this build does not know; refusing to run against a newer schema`,
      );
    }
    if (row.version !== index + 1) {
      throw new MigrationError("MIGRATION_GAP", `schema_migrations has a gap before version ${row.version}`);
    }
    if (row.checksum !== migrationChecksum(m.sql)) {
      throw new MigrationError(
        "MIGRATION_CHECKSUM_MISMATCH",
        `Migration ${row.version} (${row.name}) was modified after it was applied (checksum mismatch)`,
      );
    }
  });
}

export function pendingMigrations(db: SqliteDatabase, known: readonly Migration[] = MIGRATIONS): Migration[] {
  const applied = readAppliedMigrations(db);
  verifyAppliedMigrations(applied, known);
  return known.filter((m) => m.version > applied.length);
}

/**
 * Apply pending migrations in order, one IMMEDIATE transaction each (schema + bookkeeping commit together).
 * Safe to call repeatedly and from concurrent processes: pending state is re-read inside the transaction.
 * `beforeEach` runs before a migration is attempted (outside its transaction).
 */
export function migrate(
  db: SqliteDatabase,
  options: { migrations?: readonly Migration[]; now?: () => Date; beforeEach?: (m: Migration) => void } = {},
): MigrationReport {
  const known = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => new Date());
  db.exec(CREATE_MIGRATIONS_TABLE);
  const applied: number[] = [];
  for (const migration of known) {
    const apply = db.transaction(() => {
      const rows = readAppliedMigrations(db);
      verifyAppliedMigrations(rows, known);
      if (rows.length >= migration.version) return false;
      if (rows.length !== migration.version - 1) {
        throw new MigrationError("MIGRATION_GAP", `Cannot apply migration ${migration.version} after ${rows.length}`);
      }
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
        migration.version,
        migration.name,
        migrationChecksum(migration.sql),
        now().toISOString(),
      );
      db.pragma(`user_version = ${migration.version}`);
      return true;
    });
    // Cheap pre-check avoids a write lock when already current.
    const done = readAppliedMigrations(db).length >= migration.version;
    if (done) {
      verifyAppliedMigrations(readAppliedMigrations(db), known);
      continue;
    }
    options.beforeEach?.(migration);
    try {
      if (apply.immediate()) applied.push(migration.version);
    } catch (err) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError("MIGRATION_FAILED", `Migration ${migration.version} (${migration.name}) failed and was rolled back`, {
        cause: err,
      });
    }
  }
  const currentVersion = readAppliedMigrations(db).length;
  return { applied, currentVersion, total: known.length };
}

/**
 * Boot-time migration with a safety net: when an EXISTING database (at least one migration applied) is about to
 * receive a migration flagged `destructive`, a consistent backup is written first (SQLite backup API) and its
 * path is returned. A failed migration rolls back completely and leaves the previous schema version in place;
 * restore the preflight backup (`npm run db:restore -- <file>`, server stopped) to return to the old build.
 */
export async function migrateWithPreflight(
  db: SqliteDatabase,
  options: { migrations?: readonly Migration[]; backup: (reason: string) => Promise<string> },
): Promise<MigrationReport & { preflightBackup: string | null }> {
  const known = options.migrations ?? MIGRATIONS;
  db.exec(CREATE_MIGRATIONS_TABLE);
  const appliedCount = readAppliedMigrations(db).length;
  const pending = pendingMigrations(db, known);
  let preflightBackup: string | null = null;
  if (appliedCount > 0 && pending.some((m) => m.destructive)) {
    preflightBackup = await options.backup(`pre-migrate-v${appliedCount}-to-v${known[known.length - 1]!.version}`);
  }
  const report = migrate(db, { migrations: known });
  return { ...report, preflightBackup };
}
