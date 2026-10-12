import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Advisory owner lock: `<database>.lock` holds the PID of the running server. The server takes it
 * before opening the database; offline operations that replace the file (restore) refuse while a
 * live process holds it. A lock left by a crashed process (PID no longer alive) is treated as stale.
 */
export function lockPathFor(databasePath: string): string {
  return `${databasePath}.lock`;
}

type LockInfo = { pid: number; startedAt: string };

function readLock(path: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    return typeof parsed.pid === "number" ? { pid: parsed.pid, startedAt: String(parsed.startedAt) } : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Returns the live holder of the lock, or null when unlocked or stale. */
export function lockHolder(databasePath: string): LockInfo | null {
  const info = readLock(lockPathFor(databasePath));
  return info && isAlive(info.pid) ? info : null;
}

export class DatabaseLockedError extends Error {
  constructor(readonly holderPid: number) {
    super(`The database is in use by process ${holderPid}; stop the server first`);
    this.name = "DatabaseLockedError";
  }
}

/** Takes the owner lock for this process. Returns a release function. */
export function acquireDatabaseLock(databasePath: string): () => void {
  const path = lockPathFor(databasePath);
  mkdirSync(dirname(path), { recursive: true }); // fresh machine: data dir may not exist yet
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return () => {
        const current = readLock(path);
        if (current?.pid === process.pid) rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLock(path);
      if (holder && isAlive(holder.pid)) throw new DatabaseLockedError(holder.pid);
      rmSync(path, { force: true }); // stale lock from a dead process
    }
  }
  throw new Error(`Could not acquire database lock ${path}`);
}
