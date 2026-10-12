/**
 * Migration 1: full schema from docs/ARCHITECTURE.md.
 * Rules: scores/exponents are TEXT canonical decimals (never REAL); timestamps are UTC ISO-8601 TEXT
 * (fixed width, so lexical order == chronological order); JSON columns are guarded by json_valid().
 * This text is checksummed (sha256) by schema_migrations; never edit it after release - add migration N+1.
 */

/** SQL fragment: column is a canonical nonnegative base-10 integer string. */
const DECIMAL = (col: string) =>
  `length(${col}) > 0 AND ${col} NOT GLOB '*[^0-9]*' AND (${col} = '0' OR ${col} NOT GLOB '0*')`;

export const MIGRATION_0001_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  username_normalized TEXT NOT NULL UNIQUE CHECK (length(username_normalized) BETWEEN 3 AND 64),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (deleted_at IS NULL OR password_hash = '')
) STRICT;

CREATE TABLE guests (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((user_id IS NOT NULL) + (guest_id IS NOT NULL) = 1),
  CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_sessions_guest ON sessions(guest_id) WHERE guest_id IS NOT NULL;
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences TEXT NOT NULL CHECK (json_valid(preferences)),
  games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  best_score TEXT NOT NULL DEFAULT '0' CHECK (${DECIMAL("best_score")}),
  best_exponent TEXT NOT NULL DEFAULT '0' CHECK (${DECIMAL("best_exponent")}),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE rulesets (
  version TEXT PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 128),
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER rulesets_immutable_update BEFORE UPDATE ON rulesets
BEGIN SELECT RAISE(ABORT, 'rulesets are immutable'); END;
CREATE TRIGGER rulesets_immutable_delete BEFORE DELETE ON rulesets
BEGIN SELECT RAISE(ABORT, 'rulesets are immutable'); END;

CREATE TABLE seasons (
  id TEXT PRIMARY KEY,
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('upcoming', 'active', 'closed')),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
) STRICT;

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  title TEXT NOT NULL,
  seed TEXT NOT NULL CHECK (length(seed) BETWEEN 1 AND 128),
  move_cap INTEGER NOT NULL CHECK (move_cap > 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_challenges_season ON challenges(season_id, status);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  kind TEXT NOT NULL CHECK (kind IN ('human-vs-human', 'human-vs-bot', 'bot-vs-bot')),
  seed TEXT NOT NULL CHECK (length(seed) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('lobby', 'active', 'finished')),
  outcome TEXT CHECK (outcome IN ('seat0', 'seat1', 'draw')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  CHECK ((status = 'finished') = (outcome IS NOT NULL)),
  CHECK ((status = 'finished') = (finalized_at IS NOT NULL))
) STRICT;
CREATE INDEX idx_matches_status ON matches(status, created_at);
CREATE INDEX idx_matches_standings ON matches(season_id, ruleset_version, status);

CREATE TABLE games (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_user_id TEXT REFERENCES users(id),
  owner_guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('classic', 'practice', 'ranked', 'bot-exhibition', 'duel', 'bot-duel', 'bot-league')),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  engine_version TEXT NOT NULL,
  seed TEXT NOT NULL CHECK (length(seed) BETWEEN 1 AND 128),
  board_size INTEGER NOT NULL CHECK (board_size BETWEEN 3 AND 8),
  cells_json TEXT NOT NULL CHECK (json_valid(cells_json)),
  rng_json TEXT NOT NULL CHECK (json_valid(rng_json)),
  score TEXT NOT NULL CHECK (${DECIMAL("score")}),
  max_exponent TEXT NOT NULL CHECK (${DECIMAL("max_exponent")}),
  accepted_moves INTEGER NOT NULL CHECK (accepted_moves >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'forfeited')),
  celebrated2048 INTEGER NOT NULL DEFAULT 0 CHECK (celebrated2048 IN (0, 1)),
  challenge_id TEXT REFERENCES challenges(id),
  match_id TEXT REFERENCES matches(id),
  seat INTEGER CHECK (seat IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (accepted_moves <= revision),
  CHECK (owner_user_id IS NULL OR owner_guest_id IS NULL),
  CHECK (owner_guest_id IS NULL OR mode IN ('classic', 'practice', 'bot-exhibition')),
  CHECK (mode IN ('bot-duel', 'bot-league') OR owner_user_id IS NOT NULL OR owner_guest_id IS NOT NULL),
  CHECK (mode NOT IN ('ranked', 'duel') OR owner_user_id IS NOT NULL),
  CHECK (mode NOT IN ('ranked', 'classic', 'practice') OR match_id IS NULL),
  CHECK ((match_id IS NULL) = (seat IS NULL)),
  CHECK (mode <> 'ranked' OR challenge_id IS NOT NULL),
  CHECK (challenge_id IS NULL OR mode = 'ranked')
) STRICT;
CREATE INDEX idx_games_owner_status ON games(owner_user_id, status, updated_at DESC, id DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_games_guest_status ON games(owner_guest_id, status, updated_at DESC, id DESC) WHERE owner_guest_id IS NOT NULL;
CREATE INDEX idx_games_match ON games(match_id) WHERE match_id IS NOT NULL;
-- Boards order by (length, lexical) of canonical decimals: exact, never REAL. Created order and id make the order total.
CREATE INDEX idx_games_board ON games(mode, ruleset_version, length(score) DESC, score DESC, length(max_exponent) DESC, max_exponent DESC, created_at, id);

CREATE TABLE challenge_attempts (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  account_id TEXT NOT NULL REFERENCES users(id),
  game_id TEXT NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'forfeited')),
  official_score TEXT CHECK (official_score IS NULL OR (${DECIMAL("official_score")})),
  official_max_exponent TEXT CHECK (official_max_exponent IS NULL OR (${DECIMAL("official_max_exponent")})),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (challenge_id, account_id),
  CHECK ((status = 'active') = (finished_at IS NULL))
) STRICT;
CREATE INDEX idx_attempts_account ON challenge_attempts(account_id, status);

CREATE TABLE match_seats (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat INTEGER NOT NULL CHECK (seat IN (0, 1)),
  account_id TEXT REFERENCES users(id),
  bot_config_json TEXT CHECK (bot_config_json IS NULL OR json_valid(bot_config_json)),
  game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
  terminal_reason TEXT CHECK (terminal_reason IN ('move-cap', 'dead', 'forfeit')),
  PRIMARY KEY (match_id, seat),
  CHECK ((account_id IS NOT NULL) + (bot_config_json IS NOT NULL) = 1)
) STRICT;
CREATE INDEX idx_match_seats_account ON match_seats(account_id) WHERE account_id IS NOT NULL;

CREATE TABLE ratings (
  account_id TEXT NOT NULL REFERENCES users(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  rating INTEGER NOT NULL CHECK (rating >= 0),
  played INTEGER NOT NULL DEFAULT 0 CHECK (played >= 0),
  won INTEGER NOT NULL DEFAULT 0 CHECK (won >= 0),
  drawn INTEGER NOT NULL DEFAULT 0 CHECK (drawn >= 0),
  lost INTEGER NOT NULL DEFAULT 0 CHECK (lost >= 0),
  PRIMARY KEY (account_id, season_id, ruleset_version),
  CHECK (won + drawn + lost = played)
) STRICT;
CREATE INDEX idx_ratings_standings ON ratings(season_id, ruleset_version, rating DESC, account_id);

CREATE TABLE rating_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id),
  account_id TEXT NOT NULL REFERENCES users(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  rating_before INTEGER NOT NULL CHECK (rating_before >= 0),
  rating_after INTEGER NOT NULL CHECK (rating_after >= 0),
  delta INTEGER NOT NULL,
  outcome_x2 INTEGER NOT NULL CHECK (outcome_x2 IN (0, 1, 2)),
  idempotency_key TEXT NOT NULL UNIQUE,
  algorithm TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (match_id, account_id),
  CHECK (rating_after - rating_before = delta)
) STRICT;
CREATE TRIGGER rating_events_immutable_update BEFORE UPDATE ON rating_events
BEGIN SELECT RAISE(ABORT, 'rating_events are append-only'); END;
CREATE TRIGGER rating_events_immutable_delete BEFORE DELETE ON rating_events
BEGIN SELECT RAISE(ABORT, 'rating_events are append-only'); END;

CREATE TABLE game_commands (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('move', 'undo', 'forfeit', 'end')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  revision_after INTEGER NOT NULL CHECK (revision_after >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (game_id, command_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE game_moves (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'undo', 'forfeit', 'end')),
  direction TEXT CHECK (direction IN ('up', 'right', 'down', 'left')),
  accepted_moves INTEGER NOT NULL CHECK (accepted_moves >= 0),
  events_json TEXT NOT NULL CHECK (json_valid(events_json)),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (game_id, revision),
  UNIQUE (game_id, command_id),
  CHECK ((kind = 'move') = (direction IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE game_snapshots (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  state_checksum TEXT NOT NULL CHECK (length(state_checksum) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (game_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE game_undo_stack (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  accepted_moves INTEGER NOT NULL CHECK (accepted_moves >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  PRIMARY KEY (game_id, accepted_moves)
) STRICT, WITHOUT ROWID;

CREATE TABLE bot_runs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  bot_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('exhibition', 'league')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'finished', 'cancelled', 'error')),
  game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
  match_id TEXT REFERENCES matches(id),
  moves INTEGER NOT NULL DEFAULT 0 CHECK (moves >= 0),
  metrics_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metrics_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE INDEX idx_bot_runs_status ON bot_runs(status, created_at);

CREATE TABLE replay_exports (
  id TEXT PRIMARY KEY,
  game_id TEXT REFERENCES games(id) ON DELETE CASCADE,
  match_id TEXT REFERENCES matches(id),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  created_at TEXT NOT NULL,
  CHECK ((game_id IS NOT NULL) + (match_id IS NOT NULL) >= 1)
) STRICT;
`;
