import type { DatabaseSync } from "node:sqlite";

export type SessionKind = "account" | "guest";

export type SessionRow = {
  id: number;
  tokenHash: string;
  kind: SessionKind;
  userId: string | null;
  guestId: string | null;
  createdAt: string;
  expiresAt: string;
};

type RawSession = {
  id: number;
  token_hash: string;
  kind: SessionKind;
  user_id: string | null;
  guest_id: string | null;
  created_at: string;
  expires_at: string;
};

function toSession(row: RawSession | undefined): SessionRow | null {
  if (!row) return null;
  return {
    id: row.id,
    tokenHash: row.token_hash,
    kind: row.kind,
    userId: row.user_id,
    guestId: row.guest_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Sessions store only SHA-256 hashes of bearer tokens; raw tokens never reach the database. */
export const sessionsRepo = {
  insert(
    db: DatabaseSync,
    session: {
      tokenHash: string;
      kind: SessionKind;
      userId?: string | null;
      guestId?: string | null;
      now: string;
      expiresAt: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO sessions (token_hash, kind, user_id, guest_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      session.tokenHash,
      session.kind,
      session.userId ?? null,
      session.guestId ?? null,
      session.now,
      session.expiresAt,
    );
  },

  /** An unexpired, unrevoked session of the given kind; for accounts, the user must not be deleted. */
  findActive(db: DatabaseSync, tokenHash: string, kind: SessionKind, now: string): SessionRow | null {
    return toSession(
      db
        .prepare(
          `SELECT s.id, s.token_hash, s.kind, s.user_id, s.guest_id, s.created_at, s.expires_at
             FROM sessions s
             LEFT JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.kind = ? AND s.revoked_at IS NULL AND s.expires_at > ?
              AND (s.kind = 'guest' OR u.deleted_at IS NULL)`,
        )
        .get(tokenHash, kind, now) as RawSession | undefined,
    );
  },

  revoke(db: DatabaseSync, tokenHash: string, now: string): boolean {
    const result = db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(now, tokenHash);
    return Number(result.changes) === 1;
  },

  /** Revokes every active session of a user, optionally keeping one. Returns the number revoked. */
  revokeAllForUser(
    db: DatabaseSync,
    userId: string,
    now: string,
    exceptTokenHash: string | null = null,
  ): number {
    const result = db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR token_hash <> ?)`,
      )
      .run(now, userId, exceptTokenHash, exceptTokenHash);
    return Number(result.changes);
  },

  countActiveForUser(db: DatabaseSync, userId: string, now: string): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?",
      )
      .get(userId, now) as { n: number };
    return Number(row.n);
  },

  /** Housekeeping: delete sessions that expired or were revoked before `before`. */
  purgeInactive(db: DatabaseSync, before: string): number {
    const result = db
      .prepare("DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)")
      .run(before, before);
    return Number(result.changes);
  },
};
