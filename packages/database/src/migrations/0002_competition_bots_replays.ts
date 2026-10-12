/**
 * Migration 2: competition read models, bot run bookkeeping, imported replays.
 * Additive only (no destructive transform), so no preflight backup is required.
 */
export const MIGRATION_0002_SQL = `
ALTER TABLE games ADD COLUMN bot_label TEXT CHECK (bot_label IS NULL OR length(bot_label) BETWEEN 1 AND 128);

-- Monotone per-match version for realtime ordering; bumped on every persisted match change.
ALTER TABLE matches ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0);

CREATE INDEX idx_attempts_standing ON challenge_attempts(
  challenge_id, status, length(official_score) DESC, official_score DESC, length(official_max_exponent) DESC, official_max_exponent DESC
);

ALTER TABLE bot_runs ADD COLUMN owner_guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE;
ALTER TABLE bot_runs ADD COLUMN game_seed TEXT;
ALTER TABLE bot_runs ADD COLUMN ruleset_version TEXT;
ALTER TABLE bot_runs ADD COLUMN max_moves INTEGER CHECK (max_moves IS NULL OR max_moves > 0);
ALTER TABLE bot_runs ADD COLUMN pace_ms INTEGER NOT NULL DEFAULT 0 CHECK (pace_ms >= 0);
ALTER TABLE bot_runs ADD COLUMN last_explanation TEXT;
CREATE INDEX idx_bot_runs_owner ON bot_runs(owner_user_id, created_at DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_bot_runs_guest ON bot_runs(owner_guest_id, created_at DESC) WHERE owner_guest_id IS NOT NULL;

CREATE TABLE replay_imports (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_user_id TEXT REFERENCES users(id),
  owner_guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  ruleset_version TEXT NOT NULL,
  seed TEXT NOT NULL CHECK (length(seed) BETWEEN 1 AND 128),
  final_score TEXT NOT NULL CHECK (length(final_score) > 0 AND final_score NOT GLOB '*[^0-9]*' AND (final_score = '0' OR final_score NOT GLOB '0*')),
  max_exponent TEXT NOT NULL CHECK (length(max_exponent) > 0 AND max_exponent NOT GLOB '*[^0-9]*' AND (max_exponent = '0' OR max_exponent NOT GLOB '0*')),
  accepted_moves INTEGER NOT NULL CHECK (accepted_moves >= 0),
  final_checksum TEXT NOT NULL CHECK (length(final_checksum) = 64),
  replay_json TEXT NOT NULL CHECK (json_valid(replay_json)),
  created_at TEXT NOT NULL,
  CHECK ((owner_user_id IS NOT NULL) + (owner_guest_id IS NOT NULL) = 1)
) STRICT;
CREATE INDEX idx_replay_imports_owner ON replay_imports(owner_user_id, created_at DESC, id DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_replay_imports_guest ON replay_imports(owner_guest_id, created_at DESC, id DESC) WHERE owner_guest_id IS NOT NULL;
`;
