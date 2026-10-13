import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OpenOptions = {
  /** Milliseconds SQLite waits on a competing lock before failing with SQLITE_BUSY. */
  busyTimeoutMs?: number;
  readOnly?: boolean;
  /**
   * WAL durability level. NORMAL (default) is crash-safe for PROCESS termination and keeps the database
   * consistent, but an OS crash or power loss may lose the most recently committed transactions.
   * FULL fsyncs on every commit (slower writes) and also survives power loss. Env: DB_SYNCHRONOUS.
   */
  synchronous?: "NORMAL" | "FULL";
};

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Opens the game database with the required pragmas: WAL journal, enforced foreign keys,
 * a busy timeout, and defensive mode (no writes to sqlite internals via SQL).
 */
export function openDatabase(path: string, options: OpenOptions = {}): DatabaseSync {
  const readOnly = options.readOnly ?? false;
  if (!readOnly && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true });
  const busy = Math.max(0, Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
  db.exec(`PRAGMA busy_timeout = ${busy}`);
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA synchronous = ${options.synchronous === "FULL" ? "FULL" : "NORMAL"}`);
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.enableDefensive(true);
  return db;
}

/** Current UTC time as the canonical stored timestamp (ISO-8601 with milliseconds, `Z`). */
export function isoNow(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}
