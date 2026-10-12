import type { DatabaseSync } from "node:sqlite";
import { LIMITS } from "@g2048/contracts";
import { DbBusyError, isSqliteBusy } from "./errors.js";

/** A unit of work for the writer. It MUST be synchronous: no awaits inside a transaction. */
export type WriteWork<T> = (db: DatabaseSync) => T;

/**
 * Runs `work` inside BEGIN IMMEDIATE ... COMMIT on `db`, rolling back on any error.
 * SQLITE_BUSY (another process holding the write lock past busy_timeout) becomes DbBusyError.
 */
export function transactionSync<T>(db: DatabaseSync, work: WriteWork<T>): T {
  if (db.isTransaction) throw new Error("Nested write transaction is not allowed");
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (isSqliteBusy(error)) throw new DbBusyError();
    throw error;
  }
  try {
    const result = work(db);
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      throw new TypeError("Write work must be synchronous (it returned a promise)");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    if (isSqliteBusy(error)) throw new DbBusyError();
    throw error;
  }
}

type Job = { work: WriteWork<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };

export type WriterOptions = { maxQueue?: number };

/**
 * The single authoritative writer. All mutations go through one connection, one transaction at a
 * time, in FIFO order. The queue is bounded: when full, `run` rejects immediately with DbBusyError
 * (HTTP 503 DB_BUSY) instead of growing without limit.
 */
export class DatabaseWriter {
  readonly db: DatabaseSync;
  readonly maxQueue: number;
  #queue: Job[] = [];
  #scheduled = false;
  #closed = false;
  #idleWaiters: (() => void)[] = [];

  constructor(db: DatabaseSync, options: WriterOptions = {}) {
    this.db = db;
    this.maxQueue = options.maxQueue ?? LIMITS.dbWriterQueueMax;
  }

  get pending(): number {
    return this.#queue.length;
  }

  run<T>(work: WriteWork<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new DbBusyError("The database writer is shutting down"));
    if (this.#queue.length >= this.maxQueue) {
      return Promise.reject(new DbBusyError("The database write queue is full; retry shortly"));
    }
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ work, resolve: resolve as (value: unknown) => void, reject });
      this.#schedule();
    });
  }

  /** Resolves once every queued job has finished. */
  idle(): Promise<void> {
    if (this.#queue.length === 0 && !this.#scheduled) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Stops accepting work and waits for queued jobs to finish. Does not close the connection. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.idle();
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => this.#pump());
  }

  #pump(): void {
    const job = this.#queue.shift();
    if (job) {
      try {
        job.resolve(transactionSync(this.db, job.work));
      } catch (error) {
        job.reject(error);
      }
    }
    if (this.#queue.length > 0) {
      setImmediate(() => this.#pump());
      return;
    }
    this.#scheduled = false;
    for (const waiter of this.#idleWaiters.splice(0)) waiter();
  }
}
