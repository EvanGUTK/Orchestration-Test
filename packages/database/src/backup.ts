import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { RestoreError } from "./errors.js";
import { acquireDatabaseLock, DatabaseLockedError } from "./lock.js";
import { inspectMigrations, migrate, type Migration } from "./migrate.js";
import { sha256Hex } from "./rulesets.js";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Renames a database file and its -wal/-shm/-journal sidecars (when present) to `destination*`. */
function moveAside(path: string, destination: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${destination}${suffix}`);
  }
  renameSync(path, destination);
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

/** Converts a freshly written copy to a self-contained rollback-journal file and checks integrity. */
function finalizeCopy(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error("Backup copy failed integrity_check");
    }
  } finally {
    db.close();
  }
}

/**
 * WAL-safe online backup through the SQLite backup API (includes committed WAL content; never a raw
 * file copy of a live database). Written to a temporary name, verified, then renamed into place, so a
 * failed backup never leaves a partial file at `destination`.
 */
export async function backupDatabase(db: DatabaseSync, destination: string): Promise<string> {
  if (existsSync(destination)) throw new Error(`Backup destination already exists: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${randomBytes(4).toString("hex")}`;
  try {
    await sqliteBackup(db, partial);
    finalizeCopy(partial);
    renameSync(partial, destination);
  } catch (error) {
    removeDatabaseFiles(partial);
    throw error;
  }
  return destination;
}

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

function schemaObjects(db: DatabaseSync): SchemaObject[] {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as SchemaObject[];
}

/** SHA-256 over every schema object definition (type, name, table, SQL), excluding sqlite internals. */
export function schemaDigest(db: DatabaseSync): string {
  return sha256Hex(JSON.stringify(schemaObjects(db)));
}

/** Schema objects of a fresh in-memory database migrated to exactly `version`. */
function expectedSchema(migrations: readonly Migration[], version: number): SchemaObject[] {
  const mem = new DatabaseSync(":memory:");
  try {
    migrate(mem, migrations.slice(0, version));
    return schemaObjects(mem);
  } finally {
    mem.close();
  }
}

/**
 * Every object a fresh database at `version` has must exist with byte-identical SQL (no dropped or
 * edited tables, constraints, indexes, or triggers). Extra plain tables/indexes are tolerated (the
 * app never reads them); extra triggers or views are rejected because they can change behaviour.
 * Returns a problem description, or null when the schema is acceptable.
 */
export function compareSchema(
  db: DatabaseSync,
  migrations: readonly Migration[],
  version: number,
): string | null {
  const actual = new Map(schemaObjects(db).map((o) => [`${o.type}:${o.name}`, o]));
  for (const expected of expectedSchema(migrations, version)) {
    const found = actual.get(`${expected.type}:${expected.name}`);
    if (!found) return `missing ${expected.type} ${expected.name}`;
    if (found.sql !== expected.sql || found.tbl_name !== expected.tbl_name) {
      return `modified ${expected.type} ${expected.name}`;
    }
    actual.delete(`${expected.type}:${expected.name}`);
  }
  for (const extra of actual.values()) {
    if (extra.type === "trigger" || extra.type === "view") return `unexpected ${extra.type} ${extra.name}`;
  }
  return null;
}

export type ValidationReport = { appliedMigrations: number[]; pendingMigrations: number[] };

/**
 * Validates a candidate database file in place: integrity_check, foreign_key_check, and a
 * schema_migrations history that this build knows (no unknown versions, matching checksums).
 * The file is opened read-write only so its journal mode can be normalized; pass a staged copy.
 */
export function validateDatabaseFile(path: string, migrations: readonly Migration[]): ValidationReport {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = DELETE");
    const integrity = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new RestoreError(
        `integrity_check failed: ${integrity
          .map((r) => r.integrity_check)
          .slice(0, 3)
          .join("; ")}`,
      );
    }
    const fk = db.prepare("PRAGMA foreign_key_check").all();
    if (fk.length > 0) throw new RestoreError(`foreign_key_check reported ${fk.length} violation(s)`);
    const hasMigrations = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (!hasMigrations) throw new RestoreError("not a 2048 Infinite database (no schema_migrations table)");
    const status = inspectMigrations(db, migrations);
    if (status.applied.length === 0) throw new RestoreError("database has no applied migrations");
    if (status.unknown.length > 0) {
      throw new RestoreError(`migrations [${status.unknown.join(", ")}] are unknown to this build`);
    }
    if (status.mismatched.length > 0) {
      throw new RestoreError(`migration checksum mismatch for [${status.mismatched.join(", ")}]`);
    }
    const maxApplied = Math.max(...status.applied);
    if (status.applied.length !== maxApplied) {
      throw new RestoreError("migration history has gaps");
    }
    // Same versions must mean the same schema: reject hand-edited tables, triggers, or indexes.
    const problem = compareSchema(db, migrations, maxApplied);
    if (problem) {
      throw new RestoreError(`schema does not match migration ${maxApplied} of this build: ${problem}`);
    }
    return { appliedMigrations: status.applied, pendingMigrations: status.pending.map((m) => m.version) };
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError(
      `unreadable or corrupt database: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db?.close();
  }
}

export type RestoreResult = {
  restoredFrom: string;
  /** Copy of the database that was replaced, or null when the target did not exist. */
  safetyBackup: string | null;
  report: ValidationReport;
};

/**
 * Offline restore. Rules:
 *  1. Refuses while a live process holds `<target>.lock` (the server must be stopped), and holds
 *     that lock itself until the restore finishes. Refuses a source with a `-wal` sidecar.
 *  2. Copies the source to a staging file next to the target and validates the STAGED copy
 *     (integrity_check, foreign_key_check, known migration versions/checksums, and a schema digest
 *     matching a fresh database migrated to the same version; see compareSchema). Any failure deletes
 *     the staging file and leaves the active database untouched.
 *  3. Checkpoints the current target and saves it via the backup API as `<target>.pre-restore-<stamp>`;
 *     if the current target is unreadable (corrupt), it is moved aside byte-for-byte under that name
 *     together with its -wal/-shm sidecars instead.
 *  4. Atomically renames the staged file over the target and removes stale -wal/-shm sidecars.
 * Pending migrations (an older backup) are applied by the next server start / `db:migrate`.
 */
export async function restoreDatabase(
  source: string,
  target: string,
  migrations: readonly Migration[],
): Promise<RestoreResult> {
  let release: () => void;
  try {
    // Hold the owner lock for the whole restore so a server cannot start mid-restore (L4).
    release = acquireDatabaseLock(target);
  } catch (error) {
    if (error instanceof DatabaseLockedError) {
      throw new RestoreError(
        `refusing to restore: the server (pid ${error.holderPid}) holds the database; stop it first`,
      );
    }
    throw error;
  }
  try {
    return await restoreLocked(source, target, migrations);
  } finally {
    release();
  }
}

async function restoreLocked(
  source: string,
  target: string,
  migrations: readonly Migration[],
): Promise<RestoreResult> {
  if (!existsSync(source) || !statSync(source).isFile())
    throw new RestoreError(`backup not found: ${source}`);
  if (existsSync(`${source}-wal`)) {
    throw new RestoreError(
      `${source}-wal exists: the source looks like a live or uncheckpointed database. ` +
        "Restore only files written by `npm run db:backup`, or stop the program using it so SQLite checkpoints its WAL.",
    );
  }
  mkdirSync(dirname(target), { recursive: true });

  const staged = join(dirname(target), `.${basename(target)}.restore-${randomBytes(4).toString("hex")}`);
  let report: ValidationReport;
  try {
    copyFileSync(source, staged);
    report = validateDatabaseFile(staged, migrations);
  } catch (error) {
    removeDatabaseFiles(staged);
    throw error;
  }

  let safetyBackup: string | null = null;
  try {
    if (existsSync(target)) {
      safetyBackup = `${target}.pre-restore-${stamp()}`;
      try {
        const current = new DatabaseSync(target);
        try {
          current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          await backupDatabase(current, safetyBackup);
        } finally {
          current.close();
        }
        for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });
      } catch {
        // The current database is unreadable (e.g. corrupt): keep it byte-for-byte, with its
        // sidecars, instead of a SQLite-level copy, so restoring over it still works (OPS-10).
        removeDatabaseFiles(safetyBackup);
        moveAside(target, safetyBackup);
      }
    }
    renameSync(staged, target);
  } catch (error) {
    removeDatabaseFiles(staged);
    throw new RestoreError(
      `restore aborted before replacing the database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { restoredFrom: source, safetyBackup, report };
}
