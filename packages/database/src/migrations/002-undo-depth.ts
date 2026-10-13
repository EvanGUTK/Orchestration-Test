import type { Migration } from "../migrate.js";

/*
 * Migration 2 (SEC-FIX-002):
 * - games.undo_available: size of the bounded undo stack (CONTRACT-001 C11 / SEC-R2-07). A changed
 *   move pushes (capped at the ruleset historyLimit, dropping the oldest), an undo pops, a forfeit
 *   clears it. Total undo depth can therefore never exceed historyLimit.
 * - game_commands_outcome: lets the server keep only the most recent no-change command rows per
 *   game (SEC-R2-05) without scanning a game's whole command log.
 */
const sql = `
ALTER TABLE games ADD COLUMN undo_available INTEGER NOT NULL DEFAULT 0 CHECK (undo_available >= 0);
CREATE INDEX game_commands_outcome ON game_commands(game_id, outcome);
`;

export const migration002: Migration = { version: 2, name: "undo-depth-and-noop-retention", sql };
