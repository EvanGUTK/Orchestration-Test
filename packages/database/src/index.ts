import type { Database as SqliteDatabase } from "better-sqlite3";
import { accountRepo } from "./repos/users.ts";
import { gameRepo } from "./repos/games.ts";
import { competitionRepo } from "./repos/competition.ts";
import { botRunRepo } from "./repos/bots.ts";
import { replayRepo } from "./repos/replays.ts";
import { exportRepo } from "./repos/export.ts";

export { GameDb, WriteQueue, configureConnection, DEFAULT_BUSY_TIMEOUT_MS } from "./connection.ts";
export type { OpenOptions, WriteQueueOptions } from "./connection.ts";
export { MigrationError, RestoreError, isUniqueViolation, mapSqliteError } from "./errors.ts";
export { migrate, migrateWithPreflight, migrationChecksum, pendingMigrations, readAppliedMigrations, verifyAppliedMigrations } from "./migrate.ts";
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

const repoCache = new WeakMap<SqliteDatabase, ReturnType<typeof buildRepos>>();

function buildRepos(db: SqliteDatabase) {
  return { accounts: accountRepo(db), games: gameRepo(db), competition: competitionRepo(db), bots: botRunRepo(db), replays: replayRepo(db), exports: exportRepo(db) };
}

/**
 * Prepared-statement repositories bound to one connection. Statements are prepared once per connection
 * (the result is cached), so calling this on every request/transaction is cheap.
 * Call inside GameDb.write()/read() callbacks.
 */
export function createRepos(db: SqliteDatabase) {
  let r = repoCache.get(db);
  if (!r) {
    r = buildRepos(db);
    repoCache.set(db, r);
  }
  return r;
}
export type Repos = ReturnType<typeof createRepos>;
export { casualBoard, botBoard, challengeBoard, ladderBoard } from "./repos/competition.ts";
export type {
  SeasonRow, ChallengeRow, AttemptRow, MatchRow, SeatRow, RatingRow, ProfileStatsRaw, CompetitionRepo,
} from "./repos/competition.ts";
export type { BoardQuery, BoardRow } from "./repos/board.ts";
export type { BotRunRow, BotRunStatus, BotRunRepo } from "./repos/bots.ts";
export type { ReplayListRow, ReplayImportRow, ReplayRepo } from "./repos/replays.ts";
export type { ExportRepo, ExportLimits } from "./repos/export.ts";
