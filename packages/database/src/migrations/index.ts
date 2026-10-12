import { MIGRATION_0001_SQL } from "./0001_initial.ts";
import { MIGRATION_0002_SQL } from "./0002_competition_bots_replays.ts";

export type Migration = {
  version: number;
  name: string;
  sql: string;
  /** Destructive migrations (drop/rewrite data) force a preflight backup in migrateWithPreflight(). */
  destructive?: boolean;
};

/** Append-only. Released entries are immutable: their sha256 is recorded in schema_migrations. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", sql: MIGRATION_0001_SQL },
  { version: 2, name: "competition_bots_replays", sql: MIGRATION_0002_SQL },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
