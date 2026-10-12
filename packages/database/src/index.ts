import type { Database as SqliteDatabase } from "better-sqlite3";
import { accountRepo } from "./repos/users.ts";
import { gameRepo } from "./repos/games.ts";

export { GameDb, WriteQueue, configureConnection, DEFAULT_BUSY_TIMEOUT_MS } from "./connection.ts";
export type { OpenOptions, WriteQueueOptions } from "./connection.ts";
export { MigrationError, RestoreError, isUniqueViolation, mapSqliteError } from "./errors.ts";
export { migrate, migrationChecksum, pendingMigrations, readAppliedMigrations, verifyAppliedMigrations } from "./migrate.ts";
export type { MigrationReport, AppliedMigration } from "./migrate.ts";
export { MIGRATIONS, LATEST_SCHEMA_VERSION } from "./migrations/index.ts";
export type { Migration } from "./migrations/index.ts";
export { backupDatabase, restoreDatabase, validateDatabaseFile, defaultBackupDir, defaultBackupPath, REQUIRED_TABLES } from "./backup.ts";
export type { BackupResult, RestoreResult, ValidationReport } from "./backup.ts";
export { maxExponentOf } from "./repos/games.ts";
export type {
  GameMeta, StoredGame, CommandKind, CommandRow, MoveRow, SnapshotRow, ListGamesFilter, GameRepo,
} from "./repos/games.ts";
export type { UserRow, GuestRow, SessionRow, ProfileRow, AccountRepo } from "./repos/users.ts";

/** Prepared-statement repositories bound to one connection. Call inside GameDb.write()/read() callbacks. */
export function createRepos(db: SqliteDatabase) {
  return { accounts: accountRepo(db), games: gameRepo(db) };
}
export type Repos = ReturnType<typeof createRepos>;
