import type { DatabaseSync } from "node:sqlite";
import { MigrationError } from "./errors.js";
import { syncBuiltinRulesets, sha256Hex } from "./rulesets.js";

export type Migration = { version: number; name: string; sql: string };

export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT`;

export function migrationChecksum(migration: Migration): string {
  return sha256Hex(migration.sql);
}

export type MigrationStatus = {
  applied: number[];
  pending: Migration[];
  /** Versions recorded in the database that this build does not know (database from a newer build). */
  unknown: number[];
  /** Versions whose recorded checksum differs from this build's SQL (tampered or edited migration). */
  mismatched: number[];
};

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

/** Read-only comparison of recorded migrations against this build. */
export function inspectMigrations(db: DatabaseSync, migrations: readonly Migration[]): MigrationStatus {
  const rows = hasTable(db, "schema_migrations")
    ? (db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as {
        version: number;
        checksum: string;
      }[])
    : [];
  const known = new Map(migrations.map((m) => [m.version, m]));
  const recorded = new Map(rows.map((r) => [r.version, r.checksum]));
  const unknown = rows.filter((r) => !known.has(r.version)).map((r) => r.version);
  const mismatched = rows
    .filter((r) => {
      const m = known.get(r.version);
      return m !== undefined && migrationChecksum(m) !== r.checksum;
    })
    .map((r) => r.version);
  const pending = migrations.filter((m) => !recorded.has(m.version));
  return { applied: rows.map((r) => r.version), pending, unknown, mismatched };
}

function assertOrdered(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new MigrationError(`Migration list must be 1..N, found ${m.version} at ${i}`);
  });
}

export function assertMigrationsCompatible(status: MigrationStatus): void {
  if (status.unknown.length > 0) {
    throw new MigrationError(
      `Database has migrations [${status.unknown.join(", ")}] unknown to this build; use a newer build or restore a matching backup`,
    );
  }
  if (status.mismatched.length > 0) {
    throw new MigrationError(
      `Migration checksum mismatch for [${status.mismatched.join(", ")}]: an applied migration was changed or tampered with`,
    );
  }
  const pendingVersions = status.pending.map((m) => m.version);
  const maxApplied = Math.max(0, ...status.applied);
  if (pendingVersions.some((v) => v < maxApplied)) {
    throw new MigrationError(`Migration history has gaps below version ${maxApplied}`);
  }
}

export type MigrateOptions = { now?: () => Date };

/**
 * Verifies recorded migrations, then applies each pending migration in its own
 * BEGIN IMMEDIATE transaction (DDL is transactional in SQLite, so a failing migration leaves
 * the previous schema and data untouched). Finally seeds/verifies built-in rulesets.
 * Returns the versions applied by this call.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): number[] {
  assertOrdered(migrations);
  const now = (): string => (options.now ?? (() => new Date()))().toISOString();
  db.exec(SCHEMA_MIGRATIONS_DDL);
  const status = inspectMigrations(db, migrations);
  assertMigrationsCompatible(status);

  const done: number[] = [];
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of status.pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration), now());
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new MigrationError(`Migration ${migration.version} left foreign key violations`);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      const reason = error instanceof Error ? error.message : String(error);
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${reason}`,
      );
    }
    done.push(migration.version);
  }

  if (hasTable(db, "rulesets")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      syncBuiltinRulesets(db, now());
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  return done;
}
