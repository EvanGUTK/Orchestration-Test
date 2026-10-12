import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { RestoreError } from "./errors.js";
import { lockHolder } from "./lock.js";
import { inspectMigrations, type Migration } from "./migrate.js";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
 *  1. Refuses while a live process holds `<target>.lock` (the server must be stopped).
 *  2. Copies the source to a staging file next to the target and validates the STAGED copy
 *     (integrity_check, foreign_key_check, known migration versions/checksums). Any failure deletes
 *     the staging file and leaves the active database untouched.
 *  3. Checkpoints the current target and saves it via the backup API as `<target>.pre-restore-<stamp>`.
 *  4. Atomically renames the staged file over the target and removes stale -wal/-shm sidecars.
 * Pending migrations (an older backup) are applied by the next server start / `db:migrate`.
 */
export async function restoreDatabase(
  source: string,
  target: string,
  migrations: readonly Migration[],
): Promise<RestoreResult> {
  const holder = lockHolder(target);
  if (holder)
    throw new RestoreError(
      `refusing to restore: the server (pid ${holder.pid}) holds the database; stop it first`,
    );
  if (!existsSync(source) || !statSync(source).isFile())
    throw new RestoreError(`backup not found: ${source}`);
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
      const current = new DatabaseSync(target);
      try {
        current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        safetyBackup = `${target}.pre-restore-${stamp()}`;
        await backupDatabase(current, safetyBackup);
      } finally {
        current.close();
      }
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });
    renameSync(staged, target);
  } catch (error) {
    removeDatabaseFiles(staged);
    throw new RestoreError(
      `restore aborted before replacing the database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { restoredFrom: source, safetyBackup, report };
}
