import type { DatabaseSync } from "node:sqlite";

export type UserRow = {
  id: string;
  usernameNormalized: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

type RawUser = {
  id: string;
  username_normalized: string;
  display_name: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
};

const COLUMNS = "id, username_normalized, display_name, password_hash, created_at, updated_at";

function toUser(row: RawUser | undefined): UserRow | null {
  if (!row) return null;
  return {
    id: row.id,
    usernameNormalized: row.username_normalized,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Repository for local accounts. Deleted (tombstoned) users are never returned. */
export const usersRepo = {
  insert(
    db: DatabaseSync,
    user: { id: string; usernameNormalized: string; displayName: string; passwordHash: string; now: string },
  ): void {
    db.prepare(
      `INSERT INTO users (id, username_normalized, display_name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(user.id, user.usernameNormalized, user.displayName, user.passwordHash, user.now, user.now);
  },

  findByUsername(db: DatabaseSync, usernameNormalized: string): UserRow | null {
    return toUser(
      db
        .prepare(`SELECT ${COLUMNS} FROM users WHERE username_normalized = ? AND deleted_at IS NULL`)
        .get(usernameNormalized) as RawUser | undefined,
    );
  },

  findById(db: DatabaseSync, id: string): UserRow | null {
    return toUser(
      db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`).get(id) as
        RawUser | undefined,
    );
  },

  usernameTaken(db: DatabaseSync, usernameNormalized: string): boolean {
    return (
      db.prepare("SELECT 1 AS ok FROM users WHERE username_normalized = ?").get(usernameNormalized) !==
      undefined
    );
  },

  updatePasswordHash(db: DatabaseSync, id: string, passwordHash: string, now: string): boolean {
    const result = db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(passwordHash, now, id);
    return Number(result.changes) === 1;
  },

  updateDisplayName(db: DatabaseSync, id: string, displayName: string, now: string): boolean {
    const result = db
      .prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(displayName, now, id);
    return Number(result.changes) === 1;
  },
};
