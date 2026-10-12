import type { DatabaseSync } from "node:sqlite";
import { backupDatabase, restoreDatabase as restoreWith, type RestoreResult } from "./backup.js";
import { openDatabase, type OpenOptions } from "./connection.js";
import {
  assertMigrationsCompatible,
  inspectMigrations,
  migrate as runMigrations,
  SCHEMA_MIGRATIONS_DDL,
  type MigrateOptions,
  type Migration,
} from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";

export { openDatabase, isoNow, DEFAULT_BUSY_TIMEOUT_MS, type OpenOptions } from "./connection.js";
export { DbBusyError, MigrationError, RestoreError, isSqliteBusy, isSqliteConstraint } from "./errors.js";
export {
  inspectMigrations,
  migrationChecksum,
  assertMigrationsCompatible,
  type Migration,
  type MigrationStatus,
  type MigrateOptions,
} from "./migrate.js";
export { MIGRATIONS, LATEST_SCHEMA_VERSION } from "./migrations/index.js";
export {
  builtinRulesetCatalogue,
  canonicalRulesetJson,
  CANONICAL_RULESET_KEYS,
  PRACTICE_TEMPLATE_JSON,
  sha256Hex,
} from "./rulesets.js";
export { DatabaseWriter, transactionSync, type WriteWork, type WriterOptions } from "./writer.js";
export { decimalOrderBy, compareCanonicalDecimal, isCanonicalDecimal } from "./decimal.js";
export { backupDatabase, validateDatabaseFile, type RestoreResult, type ValidationReport } from "./backup.js";
export { acquireDatabaseLock, lockHolder, lockPathFor, DatabaseLockedError } from "./lock.js";
export { usersRepo, type UserRow } from "./repositories/users.js";
export { sessionsRepo, type SessionRow, type SessionKind } from "./repositories/sessions.js";
export { profilesRepo, type ProfileRow } from "./repositories/profiles.js";
export { guestsRepo, type GuestRow } from "./repositories/guests.js";

/** Applies pending migrations from this build (see migrate.ts for the guarantees). */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  options: MigrateOptions = {},
): number[] {
  return runMigrations(db, migrations, options);
}

/** Offline, validated restore using this build's migration list (see backup.ts for the rules). */
export function restoreDatabase(
  source: string,
  target: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<RestoreResult> {
  return restoreWith(source, target, migrations);
}

export type PreparedDatabase = {
  db: DatabaseSync;
  applied: number[];
  /** Backup taken before upgrading an existing database, or null when nothing needed upgrading. */
  preflightBackup: string | null;
};

/**
 * Boot sequence: open, refuse incompatible history, take a preflight backup when an EXISTING
 * database has pending migrations, then migrate. Runs before the server accepts requests.
 * On failure the connection is closed and the prior data is intact (each migration is atomic and
 * the preflight backup is kept).
 */
export async function prepareDatabase(
  path: string,
  options: OpenOptions & MigrateOptions & { migrations?: readonly Migration[] } = {},
): Promise<PreparedDatabase> {
  const migrations = options.migrations ?? MIGRATIONS;
  const db = openDatabase(path, options);
  try {
    db.exec(SCHEMA_MIGRATIONS_DDL);
    const status = inspectMigrations(db, migrations);
    assertMigrationsCompatible(status);
    let preflightBackup: string | null = null;
    if (status.pending.length > 0 && status.applied.length > 0) {
      const from = Math.max(...status.applied);
      const to = Math.max(...status.pending.map((m) => m.version));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      preflightBackup = await backupDatabase(db, `${path}.pre-migrate-v${from}-to-v${to}-${stamp}`);
    }
    const applied = runMigrations(db, migrations, options);
    return { db, applied, preflightBackup };
  } catch (error) {
    db.close();
    throw error;
  }
}
