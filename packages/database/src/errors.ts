import { DomainError } from "@2048/contracts";

export class MigrationError extends Error {
  readonly code: "MIGRATION_CHECKSUM_MISMATCH" | "MIGRATION_UNKNOWN_VERSION" | "MIGRATION_FAILED" | "MIGRATION_GAP";
  constructor(code: MigrationError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
  }
}

export class RestoreError extends Error {
  readonly code: "RESTORE_INVALID" | "RESTORE_IN_USE" | "RESTORE_FAILED";
  constructor(code: RestoreError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RestoreError";
    this.code = code;
  }
}

function sqliteCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_")) return code;
  }
  return undefined;
}

/** True when `err` is a UNIQUE / PRIMARY KEY violation, optionally mentioning `column` (e.g. "users.username_normalized"). */
export function isUniqueViolation(err: unknown, column?: string): boolean {
  const code = sqliteCode(err);
  if (code !== "SQLITE_CONSTRAINT_UNIQUE" && code !== "SQLITE_CONSTRAINT_PRIMARYKEY") return false;
  return column === undefined || (err instanceof Error && err.message.includes(column));
}

/** Map infrastructure failures to typed domain errors; anything else is returned unchanged. */
export function mapSqliteError(err: unknown): unknown {
  if (err instanceof DomainError) return err;
  const code = sqliteCode(err);
  if (code === undefined) return err;
  const base = code.split("_").slice(0, 2).join("_");
  if (base === "SQLITE_BUSY" || base === "SQLITE_LOCKED") {
    return new DomainError("DB_BUSY", "The database is busy; retry shortly", { sqlite: code });
  }
  if (base === "SQLITE_FULL" || code === "SQLITE_IOERR_WRITE" || base === "SQLITE_TOOBIG" || base === "SQLITE_NOMEM") {
    return new DomainError("RESOURCE_LIMIT", "The database cannot accept more data right now", { sqlite: code });
  }
  if (base === "SQLITE_CORRUPT" || base === "SQLITE_NOTADB") {
    return new DomainError("INTERNAL_ERROR", "Database integrity failure; restore from a backup", { sqlite: code });
  }
  return err;
}
