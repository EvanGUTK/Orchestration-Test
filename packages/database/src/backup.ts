import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { RestoreError, MigrationError } from "./errors.ts";
import { migrate, pendingMigrations, readAppliedMigrations, verifyAppliedMigrations } from "./migrate.ts";
import { MIGRATIONS, type Migration } from "./migrations/index.ts";

const SQLITE_MAGIC = "SQLite format 3\0";
/** Tables a restorable game database must contain. */
export const REQUIRED_TABLES = ["schema_migrations", "users", "sessions", "games", "game_commands", "game_moves", "game_snapshots"] as const;

export type BackupResult = { path: string; bytes: number; sha256: string; migrations: number };

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function defaultBackupDir(databasePath: string): string {
  return join(dirname(resolve(databasePath)), "backups");
}

export function defaultBackupPath(databasePath: string, label = "game"): string {
  return join(defaultBackupDir(databasePath), `${label}-${stamp()}-${randomBytes(3).toString("hex")}.sqlite3`);
}

/** Open a file read-only for inspection; throws RestoreError when it is not a usable SQLite database. */
function openForInspection(path: string): SqliteDatabase {
  try {
    return new Database(path, { readonly: true, fileMustExist: true, timeout: 2000 });
  } catch (err) {
    throw new RestoreError("RESTORE_INVALID", `Not a readable SQLite database: ${(err as Error).message}`, { cause: err });
  }
}

export type ValidationReport = { ok: true; migrations: number; bytes: number };

/**
 * Validate a database file without modifying it: SQLite header, structural integrity, foreign keys,
 * required tables, and a schema_migrations history that this build understands.
 * Throws RestoreError("RESTORE_INVALID") describing the first failure.
 */
export function validateDatabaseFile(path: string, known: readonly Migration[] = MIGRATIONS): ValidationReport {
  const full = resolve(path);
  let st;
  try {
    st = statSync(full);
  } catch {
    throw new RestoreError("RESTORE_INVALID", `File not found: ${full}`);
  }
  if (!st.isFile()) throw new RestoreError("RESTORE_INVALID", `Not a regular file: ${full}`);
  if (st.size < 512) throw new RestoreError("RESTORE_INVALID", "File is too small to be a SQLite database");
  const header = Buffer.alloc(16);
  const fd = openSync(full, "r");
  try {
    readSync(fd, header, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (header.toString("latin1") !== SQLITE_MAGIC) {
    throw new RestoreError("RESTORE_INVALID", "File does not have a SQLite header (corrupt or not a database)");
  }
  const db = openForInspection(full);
  try {
    let integrity: unknown[];
    try {
      integrity = db.pragma("integrity_check") as unknown[];
    } catch (err) {
      throw new RestoreError("RESTORE_INVALID", `Integrity check could not run: ${(err as Error).message}`, { cause: err });
    }
    const first = integrity[0] as { integrity_check?: string } | undefined;
    if (integrity.length !== 1 || first?.integrity_check !== "ok") {
      throw new RestoreError("RESTORE_INVALID", `Integrity check failed: ${JSON.stringify(integrity).slice(0, 300)}`);
    }
    const fk = db.pragma("foreign_key_check") as unknown[];
    if (fk.length > 0) throw new RestoreError("RESTORE_INVALID", `Foreign key violations found (${fk.length})`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    for (const t of REQUIRED_TABLES) {
      if (!tables.has(t)) throw new RestoreError("RESTORE_INVALID", `Missing required table: ${t}`);
    }
    const applied = readAppliedMigrations(db);
    if (applied.length === 0) throw new RestoreError("RESTORE_INVALID", "schema_migrations is empty");
    try {
      verifyAppliedMigrations(applied, known);
    } catch (err) {
      if (err instanceof MigrationError) throw new RestoreError("RESTORE_INVALID", err.message, { cause: err });
      throw err;
    }
    return { ok: true, migrations: applied.length, bytes: st.size };
  } finally {
    db.close();
  }
}

/**
 * Consistent online backup using SQLite's backup API (safe while the server is running in WAL mode;
 * never a raw file copy). Writes to `<dest>.partial`, verifies it, converts it to a single self-contained
 * file (journal_mode=DELETE) and only then renames it to `dest`. Refuses to overwrite an existing file.
 */
export async function backupDatabase(source: SqliteDatabase, destPath: string): Promise<BackupResult> {
  const dest = resolve(destPath);
  if (existsSync(dest)) throw new Error(`Refusing to overwrite existing file: ${dest}`);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const partial = `${dest}.partial`;
  if (existsSync(partial)) unlinkSync(partial);
  try {
    await source.backup(partial);
    const copy = new Database(partial, { timeout: 5000 });
    try {
      copy.pragma("journal_mode = DELETE");
    } finally {
      copy.close();
    }
    const report = validateDatabaseFile(partial);
    fsyncPath(partial);
    renameSync(partial, dest);
    return { path: dest, bytes: statSync(dest).size, sha256: sha256File(dest), migrations: report.migrations };
  } catch (err) {
    for (const f of [partial, `${partial}-wal`, `${partial}-shm`, `${partial}-journal`]) {
      try {
        unlinkSync(f);
      } catch {
        /* not present */
      }
    }
    throw err;
  }
}

export type RestoreResult = {
  restoredFrom: string;
  activePath: string;
  preRestoreBackup: string | null;
  migrations: number;
};

/** Throws RESTORE_IN_USE when another process (the running server) holds the database open. */
function assertNotInUse(active: string): void {
  if (!existsSync(active)) return;
  let probe: SqliteDatabase | undefined;
  try {
    probe = new Database(active, { fileMustExist: true, timeout: 0 });
    probe.pragma("locking_mode = EXCLUSIVE");
    probe.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
      throw new RestoreError("RESTORE_IN_USE", "The database is open in another process. Stop the server before restoring.", { cause: err });
    }
    // An unreadable/corrupt active file is exactly what restore is for; carry on.
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Replace the active database with a validated backup. Run with the application STOPPED.
 *  1. validate the source file (corrupt/foreign/newer input is refused here; nothing has been touched)
 *  2. copy it through the backup API into a temp file beside the active DB and validate that copy
 *  3. snapshot the current DB into <backups>/pre-restore-*.sqlite3 (if it exists)
 *  4. delete stale -wal/-shm (a leftover WAL must never be replayed onto different data) and rename the
 *     validated temp file over the active path
 * Any failure before step 4 leaves the active database untouched.
 */
export async function restoreDatabase(
  sourcePath: string,
  activePath: string,
  options: { backupDir?: string; migrations?: readonly Migration[] } = {},
): Promise<RestoreResult> {
  const source = resolve(sourcePath);
  const active = resolve(activePath);
  const known = options.migrations ?? MIGRATIONS;
  if (source === active) throw new RestoreError("RESTORE_INVALID", "Source and active database are the same file");
  validateDatabaseFile(source, known);

  mkdirSync(dirname(active), { recursive: true, mode: 0o700 });
  const temp = join(dirname(active), `.${basename(active)}.restore-${randomBytes(4).toString("hex")}`);
  const cleanupTemp = () => {
    for (const f of [temp, `${temp}-wal`, `${temp}-shm`, `${temp}-journal`]) {
      try {
        unlinkSync(f);
      } catch {
        /* not present */
      }
    }
  };

  let migrations: number;
  try {
    const src = openForInspection(source);
    try {
      await src.backup(temp);
    } finally {
      src.close();
    }
    const copy = new Database(temp, { timeout: 5000 });
    try {
      copy.pragma("journal_mode = DELETE");
      // Bring an older (but valid) backup up to the current schema before it goes live.
      if (pendingMigrations(copy, known).length > 0) migrate(copy, { migrations: known });
    } finally {
      copy.close();
    }
    migrations = validateDatabaseFile(temp, known).migrations;
    fsyncPath(temp);
  } catch (err) {
    cleanupTemp();
    if (err instanceof RestoreError) throw err;
    throw new RestoreError("RESTORE_FAILED", `Restore failed before touching the active database: ${(err as Error).message}`, { cause: err });
  }

  try {
    assertNotInUse(active);
  } catch (err) {
    cleanupTemp();
    throw err;
  }

  let preRestoreBackup: string | null = null;
  if (existsSync(active)) {
    const backupDir = options.backupDir ?? defaultBackupDir(active);
    const target = join(backupDir, `pre-restore-${stamp()}-${randomBytes(3).toString("hex")}.sqlite3`);
    try {
      const live = new Database(active, { fileMustExist: true, timeout: 2000 });
      try {
        preRestoreBackup = (await backupDatabase(live, target)).path;
      } finally {
        live.close();
      }
    } catch {
      // Active file unreadable: keep the raw bytes as evidence instead of losing them.
      try {
        mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const salvage = target.replace(/\.sqlite3$/, ".corrupt.sqlite3");
        copyFileSync(active, salvage);
        preRestoreBackup = salvage;
      } catch (err) {
        cleanupTemp();
        throw new RestoreError("RESTORE_FAILED", `Could not preserve the current database; restore aborted: ${(err as Error).message}`, { cause: err });
      }
    }
  }

  for (const f of [`${active}-wal`, `${active}-shm`, `${active}-journal`]) {
    try {
      unlinkSync(f);
    } catch {
      /* not present */
    }
  }
  try {
    renameSync(temp, active);
  } catch (err) {
    cleanupTemp();
    throw new RestoreError("RESTORE_FAILED", `Could not install restored database: ${(err as Error).message}`, { cause: err });
  }
  return { restoredFrom: source, activePath: active, preRestoreBackup, migrations };
}
