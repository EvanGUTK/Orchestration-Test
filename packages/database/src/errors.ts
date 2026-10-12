/** Typed database failures. The server maps `DbBusyError` to the `DB_BUSY` (503) envelope. */
export class DbBusyError extends Error {
  readonly code = "DB_BUSY" as const;
  constructor(message = "The database is busy; retry shortly") {
    super(message);
    this.name = "DbBusyError";
  }
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

/** True when SQLite reported a lock conflict (SQLITE_BUSY / SQLITE_LOCKED, incl. extended codes). */
export function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    return primary === 5 || primary === 6;
  }
  return /database is (locked|busy)/i.test(error.message);
}

/** True for constraint violations (UNIQUE, CHECK, FOREIGN KEY, NOT NULL, trigger RAISE). */
export function isSqliteConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode === "number") return (errcode & 0xff) === 19;
  return /constraint failed/i.test(error.message);
}
