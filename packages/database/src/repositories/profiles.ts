import type { DatabaseSync } from "node:sqlite";

export type ProfileRow = {
  userId: string;
  preferences: Record<string, unknown>;
  gamesStarted: number;
  gamesCompleted: number;
  acceptedMoves: number;
  bestScore: string;
  maxExponent: string | null;
  updatedAt: string;
};

type RawProfile = {
  user_id: string;
  preferences: string;
  games_started: number;
  games_completed: number;
  accepted_moves: number;
  best_score: string;
  max_exponent: string | null;
  updated_at: string;
};

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const profilesRepo = {
  insert(db: DatabaseSync, userId: string, now: string, preferences: Record<string, unknown> = {}): void {
    db.prepare("INSERT INTO profiles (user_id, preferences, updated_at) VALUES (?, ?, ?)").run(
      userId,
      JSON.stringify(preferences),
      now,
    );
  },

  get(db: DatabaseSync, userId: string): ProfileRow | null {
    const row = db
      .prepare(
        `SELECT user_id, preferences, games_started, games_completed, accepted_moves, best_score, max_exponent, updated_at
           FROM profiles WHERE user_id = ?`,
      )
      .get(userId) as RawProfile | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      preferences: parseObject(row.preferences),
      gamesStarted: row.games_started,
      gamesCompleted: row.games_completed,
      acceptedMoves: row.accepted_moves,
      bestScore: row.best_score,
      maxExponent: row.max_exponent,
      updatedAt: row.updated_at,
    };
  },

  setPreferences(
    db: DatabaseSync,
    userId: string,
    preferences: Record<string, unknown>,
    now: string,
  ): boolean {
    const result = db
      .prepare("UPDATE profiles SET preferences = ?, updated_at = ? WHERE user_id = ?")
      .run(JSON.stringify(preferences), now, userId);
    return Number(result.changes) === 1;
  },
};
