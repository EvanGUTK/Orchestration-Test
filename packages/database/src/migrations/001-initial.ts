import {
  BOT_STRATEGIES,
  GAME_MODES,
  MODE_RULESET,
  PRACTICE_RULESET_VERSION,
  RNG_ALGORITHM,
} from "@g2048/contracts";
import type { Migration } from "../migrate.js";

/*
 * Migration 1: every table in docs/ARCHITECTURE.md "Database model".
 *
 * - All tables are STRICT, so no column can hold an unexpected type; there are no REAL columns.
 * - Scores / tile exponents are canonical decimal TEXT, enforced with GLOB + length checks.
 * - Timestamps are ISO-8601 UTC with milliseconds (lexically ordered TEXT).
 * - Human/bot ranking contamination is blocked by CHECKs and triggers.
 *
 * The SQL text below is generated deterministically from frozen CONTRACT-001 constants, so its
 * checksum is stable. Never edit an applied migration: add migration N+1 instead.
 */

const quote = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

/** Canonical nonnegative decimal: digits only, no leading zero unless exactly "0". */
const decimal = (col: string): string =>
  `(${col} GLOB '[0-9]*' AND ${col} NOT GLOB '*[^0-9]*' AND (${col} = '0' OR ${col} NOT GLOB '0*') AND length(${col}) <= 1000000)`;
/** Positive decimal exponent (tile value 2**exponent). */
const exponent = (col: string): string =>
  `(${col} GLOB '[1-9]*' AND ${col} NOT GLOB '*[^0-9]*' AND length(${col}) <= 20)`;
const timestamp = (col: string): string =>
  `(${col} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z')`;
const optional = (col: string, check: string): string => `(${col} IS NULL OR ${check})`;
const sha256Hex = (col: string): string => `(length(${col}) = 64 AND ${col} NOT GLOB '*[^0-9a-f]*')`;
const uuid = (col: string): string => `(length(${col}) = 36)`;
const jsonObject = (col: string): string => `(json_valid(${col}) AND json_type(${col}) = 'object')`;
const jsonArray = (col: string): string => `(json_valid(${col}) AND json_type(${col}) = 'array')`;
const textLen = (col: string, min: number, max: number): string =>
  `(length(${col}) BETWEEN ${min} AND ${max})`;

const modeRulesetPairs: [string, string][] = [
  ...Object.entries(MODE_RULESET),
  ["practice", PRACTICE_RULESET_VERSION],
];
const modeRulesetCheck = modeRulesetPairs
  .map(([mode, ruleset]) => `(mode = '${mode}' AND ruleset_version = '${ruleset}')`)
  .join(" OR ");

const sql = `
CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK ${uuid("id")},
  username_normalized TEXT UNIQUE CHECK (username_normalized IS NULL OR (${textLen("username_normalized", 3, 24)} AND username_normalized NOT GLOB '*[^a-z0-9_]*')),
  display_name TEXT NOT NULL CHECK ${textLen("display_name", 1, 48)},
  password_hash TEXT CHECK (password_hash IS NULL OR ${textLen("password_hash", 16, 512)}),
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  updated_at TEXT NOT NULL CHECK ${timestamp("updated_at")},
  deleted_at TEXT CHECK ${optional("deleted_at", timestamp("deleted_at"))},
  CHECK ((deleted_at IS NULL AND username_normalized IS NOT NULL AND password_hash IS NOT NULL)
      OR (deleted_at IS NOT NULL AND password_hash IS NULL))
) STRICT;

CREATE TABLE guests (
  id TEXT PRIMARY KEY CHECK ${uuid("id")},
  preferences TEXT NOT NULL DEFAULT '{}' CHECK ${jsonObject("preferences")},
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  last_seen_at TEXT NOT NULL CHECK ${timestamp("last_seen_at")}
) STRICT;

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK ${sha256Hex("token_hash")},
  kind TEXT NOT NULL CHECK (kind IN ('account', 'guest')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  expires_at TEXT NOT NULL CHECK ${timestamp("expires_at")},
  revoked_at TEXT CHECK ${optional("revoked_at", timestamp("revoked_at"))},
  CHECK ((kind = 'account' AND user_id IS NOT NULL AND guest_id IS NULL)
      OR (kind = 'guest' AND guest_id IS NOT NULL AND user_id IS NULL)),
  CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id, revoked_at) WHERE user_id IS NOT NULL;
CREATE INDEX sessions_guest ON sessions(guest_id) WHERE guest_id IS NOT NULL;
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences TEXT NOT NULL DEFAULT '{}' CHECK ${jsonObject("preferences")},
  games_started INTEGER NOT NULL DEFAULT 0 CHECK (games_started >= 0),
  games_completed INTEGER NOT NULL DEFAULT 0 CHECK (games_completed >= 0),
  accepted_moves INTEGER NOT NULL DEFAULT 0 CHECK (accepted_moves >= 0),
  best_score TEXT NOT NULL DEFAULT '0' CHECK ${decimal("best_score")},
  max_exponent TEXT CHECK ${optional("max_exponent", exponent("max_exponent"))},
  updated_at TEXT NOT NULL CHECK ${timestamp("updated_at")}
) STRICT;

CREATE TABLE rulesets (
  version TEXT PRIMARY KEY CHECK ${textLen("version", 1, 32)},
  rules_json TEXT NOT NULL CHECK (${jsonObject("rules_json")} AND json_extract(rules_json, '$.version') = version),
  digest TEXT NOT NULL CHECK ${sha256Hex("digest")},
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")}
) STRICT;
CREATE TRIGGER rulesets_immutable_update BEFORE UPDATE ON rulesets
BEGIN SELECT RAISE(ABORT, 'rulesets are immutable'); END;
CREATE TRIGGER rulesets_immutable_delete BEFORE DELETE ON rulesets
BEGIN SELECT RAISE(ABORT, 'rulesets are immutable'); END;

CREATE TABLE seasons (
  id TEXT PRIMARY KEY CHECK ${textLen("id", 1, 64)},
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  name TEXT NOT NULL CHECK ${textLen("name", 1, 64)},
  starts_at TEXT NOT NULL CHECK ${timestamp("starts_at")},
  ends_at TEXT CHECK (ends_at IS NULL OR (${timestamp("ends_at")} AND ends_at > starts_at)),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'active', 'archived')),
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")}
) STRICT;
CREATE UNIQUE INDEX seasons_one_active ON seasons(ruleset_version) WHERE status = 'active';

CREATE TABLE challenges (
  id TEXT PRIMARY KEY CHECK ${textLen("id", 1, 64)},
  season_id TEXT NOT NULL REFERENCES seasons(id),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  seed TEXT NOT NULL CHECK ${textLen("seed", 1, 128)},
  move_cap INTEGER NOT NULL CHECK (move_cap > 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")}
) STRICT;
CREATE INDEX challenges_season_status ON challenges(season_id, status, created_at);

CREATE TABLE games (
  id TEXT PRIMARY KEY CHECK ${uuid("id")},
  owner_user_id TEXT REFERENCES users(id),
  owner_guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN (${quote(GAME_MODES)})),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  rules_json TEXT NOT NULL CHECK (${jsonObject("rules_json")} AND json_extract(rules_json, '$.version') = ruleset_version),
  engine_version TEXT NOT NULL CHECK ${textLen("engine_version", 1, 32)},
  seed TEXT NOT NULL CHECK ${textLen("seed", 1, 128)},
  board_size INTEGER NOT NULL CHECK (board_size BETWEEN 3 AND 8),
  board_json TEXT NOT NULL CHECK ${jsonObject("board_json")},
  rng_state TEXT NOT NULL CHECK (${jsonObject("rng_state")} AND json_extract(rng_state, '$.algorithm') = '${RNG_ALGORITHM}' AND json_array_length(rng_state, '$.words') = 4),
  score TEXT NOT NULL DEFAULT '0' CHECK ${decimal("score")},
  max_exponent TEXT CHECK ${optional("max_exponent", exponent("max_exponent"))},
  accepted_moves INTEGER NOT NULL DEFAULT 0 CHECK (accepted_moves >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'forfeited')),
  celebrated_2048 INTEGER NOT NULL DEFAULT 0 CHECK (celebrated_2048 IN (0, 1)),
  state_checksum TEXT NOT NULL CHECK ${sha256Hex("state_checksum")},
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  updated_at TEXT NOT NULL CHECK ${timestamp("updated_at")},
  finished_at TEXT CHECK ${optional("finished_at", timestamp("finished_at"))},
  CHECK (owner_user_id IS NULL OR owner_guest_id IS NULL),
  CHECK (mode NOT IN ('ranked', 'duel-human') OR owner_user_id IS NOT NULL),
  CHECK (owner_guest_id IS NULL OR mode IN ('classic', 'practice', 'bot-exhibition')),
  CHECK (${modeRulesetCheck}),
  CHECK ((status = 'active') = (finished_at IS NULL))
) STRICT;
CREATE INDEX games_owner_user_saves ON games(owner_user_id, status, updated_at DESC, id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX games_owner_guest_saves ON games(owner_guest_id, status, updated_at DESC, id) WHERE owner_guest_id IS NOT NULL;
CREATE INDEX games_casual_standings ON games(mode, ruleset_version, length(score) DESC, score DESC, length(max_exponent) DESC, max_exponent DESC, created_at, id);

CREATE TABLE game_commands (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL CHECK (${textLen("command_id", 8, 64)} AND command_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  kind TEXT NOT NULL CHECK (kind IN ('move', 'undo', 'forfeit')),
  payload_hash TEXT NOT NULL CHECK ${sha256Hex("payload_hash")},
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no-change')),
  revision_before INTEGER NOT NULL CHECK (revision_before >= 0),
  revision_after INTEGER NOT NULL CHECK (revision_after >= revision_before),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  PRIMARY KEY (game_id, command_id),
  CHECK ((outcome = 'no-change') = (revision_after = revision_before))
) STRICT;

CREATE TABLE game_moves (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'undo', 'forfeit')),
  direction TEXT CHECK (direction IS NULL OR direction IN ('up', 'right', 'down', 'left')),
  score_delta TEXT NOT NULL DEFAULT '0' CHECK ${decimal("score_delta")},
  events_json TEXT NOT NULL CHECK ${jsonArray("events_json")},
  checksum TEXT NOT NULL CHECK ${sha256Hex("checksum")},
  undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1)),
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  PRIMARY KEY (game_id, revision),
  UNIQUE (game_id, command_id),
  FOREIGN KEY (game_id, command_id) REFERENCES game_commands(game_id, command_id) ON DELETE CASCADE,
  CHECK ((kind = 'move') = (direction IS NOT NULL))
) STRICT;

CREATE TABLE game_snapshots (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state_json TEXT NOT NULL CHECK ${jsonObject("state_json")},
  score TEXT NOT NULL CHECK ${decimal("score")},
  checksum TEXT NOT NULL CHECK ${sha256Hex("checksum")},
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  PRIMARY KEY (game_id, revision)
) STRICT;

CREATE TABLE challenge_attempts (
  id TEXT PRIMARY KEY CHECK ${uuid("id")},
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  game_id TEXT NOT NULL UNIQUE REFERENCES games(id),
  status TEXT NOT NULL CHECK (status IN ('in-progress', 'completed', 'forfeited')),
  official_score TEXT CHECK ${optional("official_score", decimal("official_score"))},
  official_max_exponent TEXT CHECK ${optional("official_max_exponent", exponent("official_max_exponent"))},
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  completed_at TEXT CHECK ${optional("completed_at", timestamp("completed_at"))},
  UNIQUE (user_id, challenge_id),
  CHECK ((status = 'in-progress') = (completed_at IS NULL)),
  CHECK (status <> 'completed' OR official_score IS NOT NULL)
) STRICT;
CREATE INDEX challenge_attempts_standings ON challenge_attempts(challenge_id, status, length(official_score) DESC, official_score DESC, length(official_max_exponent) DESC, official_max_exponent DESC, created_at, id);
CREATE TRIGGER challenge_attempts_ranked_only BEFORE INSERT ON challenge_attempts
WHEN (SELECT mode FROM games WHERE id = NEW.game_id) IS NOT 'ranked'
BEGIN SELECT RAISE(ABORT, 'challenge attempts require a ranked game'); END;

CREATE TABLE matches (
  id TEXT PRIMARY KEY CHECK ${uuid("id")},
  kind TEXT NOT NULL CHECK (kind IN ('human-human', 'human-bot', 'bot-bot')),
  season_id TEXT REFERENCES seasons(id),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  seed TEXT NOT NULL CHECK ${textLen("seed", 1, 128)},
  status TEXT NOT NULL CHECK (status IN ('lobby', 'active', 'finished', 'abandoned-lobby')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('seat-a', 'seat-b', 'draw')),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  updated_at TEXT NOT NULL CHECK ${timestamp("updated_at")},
  finalized_at TEXT CHECK ${optional("finalized_at", timestamp("finalized_at"))},
  CHECK ((status = 'finished') = (outcome IS NOT NULL)),
  CHECK ((status = 'finished') = (finalized_at IS NOT NULL))
) STRICT;
CREATE INDEX matches_status ON matches(status, created_at, id);

CREATE TABLE match_seats (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat TEXT NOT NULL CHECK (seat IN ('a', 'b')),
  user_id TEXT REFERENCES users(id),
  bot_strategy TEXT CHECK (bot_strategy IS NULL OR bot_strategy IN (${quote(BOT_STRATEGIES)})),
  bot_version TEXT,
  bot_config_json TEXT CHECK ${optional("bot_config_json", jsonObject("bot_config_json"))},
  game_id TEXT UNIQUE REFERENCES games(id),
  terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('move-cap', 'dead-board', 'forfeit')),
  joined_at TEXT NOT NULL CHECK ${timestamp("joined_at")},
  ended_at TEXT CHECK ${optional("ended_at", timestamp("ended_at"))},
  PRIMARY KEY (match_id, seat),
  UNIQUE (match_id, user_id),
  CHECK ((user_id IS NULL) <> (bot_strategy IS NULL)),
  CHECK ((bot_strategy IS NULL) = (bot_version IS NULL)),
  CHECK ((bot_strategy IS NULL) = (bot_config_json IS NULL)),
  CHECK ((terminal_reason IS NULL) = (ended_at IS NULL))
) STRICT;
CREATE INDEX match_seats_user ON match_seats(user_id) WHERE user_id IS NOT NULL;
CREATE TRIGGER match_seats_identity_insert BEFORE INSERT ON match_seats
WHEN ((SELECT kind FROM matches WHERE id = NEW.match_id) = 'human-human' AND NEW.user_id IS NULL)
  OR ((SELECT kind FROM matches WHERE id = NEW.match_id) = 'bot-bot' AND NEW.bot_strategy IS NULL)
BEGIN SELECT RAISE(ABORT, 'seat identity does not match the match kind'); END;
CREATE TRIGGER match_seats_identity_update BEFORE UPDATE OF user_id, bot_strategy ON match_seats
WHEN ((SELECT kind FROM matches WHERE id = NEW.match_id) = 'human-human' AND NEW.user_id IS NULL)
  OR ((SELECT kind FROM matches WHERE id = NEW.match_id) = 'bot-bot' AND NEW.bot_strategy IS NULL)
BEGIN SELECT RAISE(ABORT, 'seat identity does not match the match kind'); END;

CREATE TABLE ratings (
  user_id TEXT NOT NULL REFERENCES users(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  rating INTEGER NOT NULL,
  played INTEGER NOT NULL DEFAULT 0 CHECK (played >= 0),
  won INTEGER NOT NULL DEFAULT 0 CHECK (won >= 0),
  drawn INTEGER NOT NULL DEFAULT 0 CHECK (drawn >= 0),
  lost INTEGER NOT NULL DEFAULT 0 CHECK (lost >= 0),
  updated_at TEXT NOT NULL CHECK ${timestamp("updated_at")},
  PRIMARY KEY (user_id, season_id, ruleset_version),
  CHECK (played = won + drawn + lost)
) STRICT;
CREATE INDEX ratings_standings ON ratings(season_id, ruleset_version, rating DESC, user_id);

CREATE TABLE rating_events (
  id INTEGER PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  rating_before INTEGER NOT NULL,
  rating_after INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('1', '0.5', '0')),
  algorithm TEXT NOT NULL CHECK ${textLen("algorithm", 1, 32)},
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key = match_id || ':' || user_id),
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  UNIQUE (match_id, user_id),
  CHECK (rating_after = rating_before + delta)
) STRICT;
CREATE TRIGGER rating_events_human_only BEFORE INSERT ON rating_events
WHEN (SELECT kind FROM matches WHERE id = NEW.match_id) IS NOT 'human-human'
BEGIN SELECT RAISE(ABORT, 'rating events are only recorded for human-human matches'); END;
CREATE TRIGGER rating_events_append_only BEFORE UPDATE ON rating_events
BEGIN SELECT RAISE(ABORT, 'rating events are append-only'); END;

CREATE TABLE bot_runs (
  id TEXT PRIMARY KEY CHECK ${uuid("id")},
  owner_user_id TEXT REFERENCES users(id),
  owner_guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
  strategy TEXT NOT NULL CHECK (strategy IN (${quote(BOT_STRATEGIES)})),
  bot_version TEXT NOT NULL CHECK ${textLen("bot_version", 1, 32)},
  config_json TEXT NOT NULL CHECK ${jsonObject("config_json")},
  node_budget INTEGER NOT NULL CHECK (node_budget > 0),
  time_budget_ms INTEGER NOT NULL CHECK (time_budget_ms > 0),
  seed TEXT NOT NULL CHECK ${textLen("seed", 1, 128)},
  game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
  match_id TEXT REFERENCES matches(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'finished', 'cancelled', 'failed')),
  moves_played INTEGER NOT NULL DEFAULT 0 CHECK (moves_played >= 0),
  metrics_json TEXT NOT NULL DEFAULT '{}' CHECK ${jsonObject("metrics_json")},
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")},
  updated_at TEXT NOT NULL CHECK ${timestamp("updated_at")},
  CHECK (owner_user_id IS NULL OR owner_guest_id IS NULL)
) STRICT;
CREATE INDEX bot_runs_status ON bot_runs(status, created_at);
CREATE INDEX bot_runs_league ON bot_runs(strategy, status, created_at, id);

CREATE TABLE replay_exports (
  id TEXT PRIMARY KEY CHECK ${uuid("id")},
  game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
  match_id TEXT REFERENCES matches(id) ON DELETE SET NULL,
  replay_schema_version INTEGER NOT NULL CHECK (replay_schema_version > 0),
  engine_version TEXT NOT NULL CHECK ${textLen("engine_version", 1, 32)},
  ruleset_version TEXT NOT NULL REFERENCES rulesets(version),
  checksum TEXT NOT NULL CHECK ${sha256Hex("checksum")},
  source TEXT NOT NULL CHECK (source IN ('local', 'import')),
  created_at TEXT NOT NULL CHECK ${timestamp("created_at")}
) STRICT;
CREATE INDEX replay_exports_game ON replay_exports(game_id) WHERE game_id IS NOT NULL;
CREATE INDEX replay_exports_match ON replay_exports(match_id) WHERE match_id IS NOT NULL;
`;

export const migration001: Migration = { version: 1, name: "initial-schema", sql };
