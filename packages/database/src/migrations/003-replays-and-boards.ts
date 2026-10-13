import type { Migration } from "../migrate.js";

/*
 * Migration 3 (BACKEND-004):
 * - replay_imports: validated, never-ranked replay files imported by a local user or guest (REP-02).
 *   The verified file is stored verbatim; nothing is installed as a game or leaderboard row.
 * - games_casual_best: per-account best classic game lookup for the casual leaderboard (decimal
 *   order: length then value; never REAL).
 */
const sql = `
CREATE TABLE replay_imports (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  owner_guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  replay_schema_version INTEGER NOT NULL CHECK (replay_schema_version > 0),
  engine_version TEXT NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 32),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  final_checksum TEXT NOT NULL CHECK (length(final_checksum) = 64 AND final_checksum NOT GLOB '*[^0-9a-f]*'),
  moves INTEGER NOT NULL CHECK (moves >= 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  replay_json TEXT NOT NULL CHECK (json_valid(replay_json) AND json_type(replay_json) = 'object'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
  CHECK ((owner_user_id IS NULL) <> (owner_guest_id IS NULL))
) STRICT;
CREATE INDEX replay_imports_owner_user ON replay_imports(owner_user_id, created_at) WHERE owner_user_id IS NOT NULL;
CREATE INDEX replay_imports_owner_guest ON replay_imports(owner_guest_id, created_at) WHERE owner_guest_id IS NOT NULL;
CREATE INDEX games_casual_best ON games(owner_user_id, length(score) DESC, score DESC,
  length(max_exponent) DESC, max_exponent DESC, created_at, id)
  WHERE mode = 'classic' AND owner_user_id IS NOT NULL;
`;

export const migration003: Migration = { version: 3, name: "replay-imports-and-board-indexes", sql };
