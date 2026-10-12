import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { DomainError } from "@2048/contracts";
import { mapSqliteError } from "./errors.ts";

export type OpenOptions = {
  /** Milliseconds SQLite waits on a lock before SQLITE_BUSY (mapped to DB_BUSY). */
  busyTimeoutMs?: number;
  readonly?: boolean;
};

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Apply the standard pragmas. WAL + foreign keys are mandatory for every connection we open. */
export function configureConnection(db: SqliteDatabase, options: OpenOptions = {}): void {
  db.pragma(`busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
  if (!options.readonly) {
    const mode = db.pragma("journal_mode = WAL", { simple: true });
    if (typeof mode === "string" && mode.toLowerCase() !== "wal" && db.name !== ":memory:") {
      throw new Error(`Could not enable WAL journal mode (got ${String(mode)})`);
    }
    db.pragma("synchronous = NORMAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  db.pragma("temp_store = MEMORY");
}

/**
 * The one writer handle for the live database file. better-sqlite3 is synchronous, so every `write()`
 * is an atomic, serialized BEGIN IMMEDIATE ... COMMIT block; a thrown error rolls the whole block back.
 */
export class GameDb {
  readonly raw: SqliteDatabase;
  readonly path: string;
  #closed = false;

  private constructor(raw: SqliteDatabase, path: string) {
    this.raw = raw;
    this.path = path;
  }

  static open(path: string, options: OpenOptions = {}): GameDb {
    const full = path === ":memory:" ? path : resolve(path);
    if (full !== ":memory:") {
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    }
    let raw: SqliteDatabase;
    try {
      raw = new Database(full, { readonly: options.readonly === true, timeout: 5000 });
    } catch (err) {
      throw mapSqliteError(err);
    }
    try {
      configureConnection(raw, options);
    } catch (err) {
      raw.close();
      throw mapSqliteError(err);
    }
    if (full !== ":memory:" && !options.readonly) {
      try {
        chmodSync(full, 0o600);
      } catch {
        /* best effort on exotic filesystems */
      }
    }
    return new GameDb(raw, full);
  }

  get isOpen(): boolean {
    return !this.#closed && this.raw.open;
  }

  /** Run `fn` inside one atomic IMMEDIATE transaction. Nested calls become savepoints. */
  write<T>(fn: (db: SqliteDatabase) => T): T {
    try {
      return this.raw.transaction(fn).immediate(this.raw);
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  /** Read without opening a write transaction (WAL readers never block the writer). */
  read<T>(fn: (db: SqliteDatabase) => T): T {
    try {
      return fn(this.raw);
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  integrityCheck(): string[] {
    const rows = this.raw.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check);
  }

  /** Flush the WAL into the main file (used before clean shutdown). */
  checkpoint(): void {
    this.raw.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.raw.open && !this.raw.readonly) this.checkpoint();
    } catch {
      /* closing must not throw because a checkpoint was blocked */
    }
    this.raw.close();
  }
}

export type WriteQueueOptions = { maxPending?: number };

/**
 * Bounded FIFO in front of the writer. Tasks run one at a time and yield to the event loop between
 * tasks so health checks stay responsive under load. A full queue fails fast with DB_BUSY (HTTP 503).
 */
export class WriteQueue {
  readonly #db: GameDb;
  readonly #max: number;
  #pending = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(db: GameDb, options: WriteQueueOptions = {}) {
    this.#db = db;
    this.#max = options.maxPending ?? 512;
  }

  get pending(): number {
    return this.#pending;
  }

  submit<T>(fn: (db: SqliteDatabase) => T): Promise<T> {
    if (this.#pending >= this.#max) {
      return Promise.reject(new DomainError("DB_BUSY", "Too many pending writes; retry shortly", { pending: this.#pending }));
    }
    this.#pending++;
    const run = async (): Promise<T> => {
      await new Promise<void>((r) => setImmediate(r));
      try {
        return this.#db.write(fn);
      } finally {
        this.#pending--;
      }
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
