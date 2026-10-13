import type { Migration } from "../migrate.js";

/*
 * Migration 5 (security gate 4 L7): match_events is append-only. Updates are always refused; deletes are
 * refused while the parent match exists (a cascade from deleting the match itself is still allowed).
 */
const sql = `
CREATE TRIGGER match_events_no_update BEFORE UPDATE ON match_events
BEGIN SELECT RAISE(ABORT, 'match events are append-only'); END;
CREATE TRIGGER match_events_no_delete BEFORE DELETE ON match_events
WHEN EXISTS (SELECT 1 FROM matches WHERE id = OLD.match_id)
BEGIN SELECT RAISE(ABORT, 'match events are append-only'); END;
`;

export const migration005: Migration = { version: 5, name: "match-events-append-only", sql };
