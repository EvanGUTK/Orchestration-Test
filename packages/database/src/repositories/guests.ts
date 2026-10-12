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
};
