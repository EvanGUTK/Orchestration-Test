import type { Database as SqliteDatabase } from "better-sqlite3";

export type UserRow = {
  id: string;
  usernameNormalized: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  deletedAt: string | null;
};

export type GuestRow = { id: string; displayName: string; createdAt: string };

export type SessionRow = {
  id: number;
  tokenHash: string;
  userId: string | null;
  guestId: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
};

export type ProfileRow = {
  userId: string;
  preferencesJson: string;
  gamesPlayed: number;
  bestScore: string;
  bestExponent: string;
  updatedAt: string;
};

type Raw = Record<string, unknown>;

function user(r: Raw | undefined): UserRow | undefined {
  if (!r) return undefined;
  return {
    id: r.id as string,
    usernameNormalized: r.username_normalized as string,
    displayName: r.display_name as string,
    passwordHash: r.password_hash as string,
    createdAt: r.created_at as string,
    deletedAt: (r.deleted_at as string | null) ?? null,
  };
}

function session(r: Raw | undefined): SessionRow | undefined {
  if (!r) return undefined;
  return {
    id: r.id as number,
    tokenHash: r.token_hash as string,
    userId: (r.user_id as string | null) ?? null,
    guestId: (r.guest_id as string | null) ?? null,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    lastSeenAt: r.last_seen_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

export function accountRepo(db: SqliteDatabase) {
  const insertUser = db.prepare(
    "INSERT INTO users (id, username_normalized, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const byId = db.prepare("SELECT * FROM users WHERE id = ?");
  const byName = db.prepare("SELECT * FROM users WHERE username_normalized = ?");
  const insertProfile = db.prepare("INSERT INTO profiles (user_id, preferences, updated_at) VALUES (?, ?, ?)");
  const getProfile = db.prepare("SELECT * FROM profiles WHERE user_id = ?");
  const updatePrefs = db.prepare("UPDATE profiles SET preferences = ?, updated_at = ? WHERE user_id = ?");
  const updateName = db.prepare("UPDATE users SET display_name = ? WHERE id = ? AND deleted_at IS NULL");
  const updateHash = db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND deleted_at IS NULL");
  const insertGuest = db.prepare("INSERT INTO guests (id, display_name, created_at) VALUES (?, ?, ?)");
  const guestById = db.prepare("SELECT * FROM guests WHERE id = ?");
  const insertSession = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, guest_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const sessionByHash = db.prepare("SELECT * FROM sessions WHERE token_hash = ?");
  const touchSession = db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?");
  const revokeOne = db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
  const revokeOthers = db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL");
  const revokeAll = db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL");
  const purgeSessions = db.prepare("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)");

  return {
    createUser(u: { id: string; usernameNormalized: string; displayName: string; passwordHash: string; createdAt: string; preferencesJson: string }): void {
      insertUser.run(u.id, u.usernameNormalized, u.displayName, u.passwordHash, u.createdAt);
      insertProfile.run(u.id, u.preferencesJson, u.createdAt);
    },
    userById: (id: string) => user(byId.get(id) as Raw | undefined),
    userByUsername: (normalized: string) => user(byName.get(normalized) as Raw | undefined),
    setDisplayName: (id: string, name: string) => updateName.run(name, id).changes > 0,
    setPasswordHash: (id: string, hash: string) => updateHash.run(hash, id).changes > 0,
    profile(userId: string): ProfileRow | undefined {
      const r = getProfile.get(userId) as Raw | undefined;
      if (!r) return undefined;
      return {
        userId: r.user_id as string,
        preferencesJson: r.preferences as string,
        gamesPlayed: r.games_played as number,
        bestScore: r.best_score as string,
        bestExponent: r.best_exponent as string,
        updatedAt: r.updated_at as string,
      };
    },
    setPreferences: (userId: string, json: string, at: string) => updatePrefs.run(json, at, userId).changes > 0,

    createGuest(g: GuestRow): void {
      insertGuest.run(g.id, g.displayName, g.createdAt);
    },
    guestById(id: string): GuestRow | undefined {
      const r = guestById.get(id) as Raw | undefined;
      return r ? { id: r.id as string, displayName: r.display_name as string, createdAt: r.created_at as string } : undefined;
    },

    createSession(s: { tokenHash: string; userId?: string; guestId?: string; createdAt: string; expiresAt: string }): void {
      insertSession.run(s.tokenHash, s.userId ?? null, s.guestId ?? null, s.createdAt, s.expiresAt, s.createdAt);
    },
    sessionByTokenHash: (hash: string) => session(sessionByHash.get(hash) as Raw | undefined),
    touchSession: (id: number, at: string) => void touchSession.run(at, id),
    revokeSession: (id: number, at: string) => revokeOne.run(at, id).changes > 0,
    revokeOtherSessions: (userId: string, keepSessionId: number, at: string) => revokeOthers.run(at, userId, keepSessionId).changes,
    revokeAllSessions: (userId: string, at: string) => revokeAll.run(at, userId).changes,
    purgeExpiredSessions: (now: string, revokedBefore: string) => purgeSessions.run(now, revokedBefore).changes,

    /**
     * Account deletion: private data goes, competitive history stays anonymized under the same id.
     * Casual saves (classic/practice/bot-exhibition) are deleted with all of their commands/moves/snapshots.
     */
    anonymizeUser(userId: string, at: string): void {
      db.prepare("DELETE FROM games WHERE owner_user_id = ? AND mode IN ('classic', 'practice', 'bot-exhibition')").run(userId);
      db.prepare("DELETE FROM replay_imports WHERE owner_user_id = ?").run(userId);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM profiles WHERE user_id = ?").run(userId);
      db.prepare(
        "UPDATE users SET username_normalized = ?, display_name = 'Deleted player', password_hash = '', deleted_at = ? WHERE id = ?",
      ).run(`deleted:${userId}`, at, userId);
    },
  };
}

export type AccountRepo = ReturnType<typeof accountRepo>;
