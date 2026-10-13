import type { Migration } from "../migrate.js";

/*
 * Migration 4 (requested by the competition lane, COMP-006, relayed by chief):
 * - match_events: the per-match event log used for WebSocket catch-up. Invariant maintained by the
 *   match service in the SAME transaction: matches.sequence = MAX(match_events.sequence) for the match
 *   (matches.sequence already exists since migration 1).
 * - match_seats.bot_rng_json: persisted bot tie-break PRNG state so a bot seat resumes deterministically.
 */
const sql = `
CREATE TABLE match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL CHECK (type IN ('match.updated', 'match.seat-ended', 'match.finished', 'rating.updated')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (match_id, sequence)
) STRICT;
ALTER TABLE match_seats ADD COLUMN bot_rng_json TEXT CHECK (bot_rng_json IS NULL OR json_valid(bot_rng_json));
`;

export const migration004: Migration = { version: 4, name: "match-events-and-bot-rng", sql };
