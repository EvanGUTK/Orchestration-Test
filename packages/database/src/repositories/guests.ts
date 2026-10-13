import type { DatabaseSync } from "node:sqlite";

export type GuestRow = {
  id: string;
  preferences: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
};

type RawGuest = { id: string; preferences: string; created_at: string; last_seen_at: string };

/** Guests are a separate identity space: never users, never in human rankings. */
export const guestsRepo = {
  insert(db: DatabaseSync, id: string, now: string): void {
    db.prepare("INSERT INTO guests (id, preferences, created_at, last_seen_at) VALUES (?, '{}', ?, ?)").run(
      id,
      now,
      now,
    );
  },

  get(db: DatabaseSync, id: string): GuestRow | null {
    const row = db
      .prepare("SELECT id, preferences, created_at, last_seen_at FROM guests WHERE id = ?")
      .get(id) as RawGuest | undefined;
    if (!row) return null;
    const prefs: unknown = JSON.parse(row.preferences);
    return {
      id: row.id,
      preferences: prefs !== null && typeof prefs === "object" ? (prefs as Record<string, unknown>) : {},
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  },

  setPreferences(db: DatabaseSync, id: string, preferences: Record<string, unknown>, now: string): boolean {
    const result = db
      .prepare("UPDATE guests SET preferences = ?, last_seen_at = ? WHERE id = ?")
      .run(JSON.stringify(preferences), now, id);
    return Number(result.changes) === 1;
  },

  /**
   * Retention: delete guests that have no session left (expired sessions are purged first), were
   * last seen before `before`, and whose games were all last updated before `before`. Their games,
   * commands, moves, and snapshots cascade.
   */
  purgeAbandoned(db: DatabaseSync, before: string): number {
    const result = db
      .prepare(
        `DELETE FROM guests
          WHERE last_seen_at < ?
            AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.guest_id = guests.id)
            AND NOT EXISTS (SELECT 1 FROM games g WHERE g.owner_guest_id = guests.id AND g.updated_at >= ?)`,
      )
      .run(before, before);
    return Number(result.changes);
  },

  /** Housekeeping: delete guests with no session rows and no owned games. */
  purgeOrphans(db: DatabaseSync): number {
    const result = db
      .prepare(
        `DELETE FROM guests
          WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.guest_id = guests.id)
            AND NOT EXISTS (SELECT 1 FROM games g WHERE g.owner_guest_id = guests.id)`,
      )
      .run();
    return Number(result.changes);
  },
};
