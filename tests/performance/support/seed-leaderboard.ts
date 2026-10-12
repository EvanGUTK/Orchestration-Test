import { DatabaseSync } from "node:sqlite";
import type { Entry } from "./leaderboard-oracle.ts";

/**
 * Bulk-seeds an ALREADY MIGRATED private database with completed casual ("classic") games, one per entry, owned by
 * synthetic accounts. Direct SQL on a temp file only; never used against a real save. Mirrors columns of migration 0001.
 */
export function seedCompletedGames(dbPath: string, entries: readonly Entry[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = OFF;");
    db.exec("BEGIN");
    db.prepare("INSERT OR IGNORE INTO rulesets (version, rules_json, digest, created_at) VALUES ('classic-v1', '{}', ?, '2026-01-01T00:00:00.000Z')").run("0".repeat(64));
    const user = db.prepare("INSERT OR IGNORE INTO users (id, username_normalized, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', '2026-01-01T00:00:00.000Z')");
    const game = db.prepare(
      `INSERT INTO games (id, owner_user_id, mode, ruleset_version, engine_version, seed, board_size, cells_json, rng_json, score, max_exponent, accepted_moves, revision, status, created_at, updated_at)
       VALUES (?, ?, 'classic', 'classic-v1', 'engine-1.0.0', 'perf', 4, ?, '{"algorithm":"xoshiro128ss-v1","words":[1,2,3,4]}', ?, ?, 1, 1, 'completed', ?, ?)`,
    );
    const userIds = new Map<string, string>();
    let n = 0;
    for (const e of entries) {
      let uid = userIds.get(e.accountId);
      if (!uid) {
        uid = `10000000-0000-4000-8000-${(userIds.size).toString(16).padStart(12, "0")}`;
        userIds.set(e.accountId, uid);
        user.run(uid, e.accountId.toLowerCase().padEnd(3, "x"), e.accountId);
      }
      game.run(e.id, uid, JSON.stringify(new Array(16).fill(null).map((_, i) => (i === 0 ? e.maxExponent : null))), e.score, e.maxExponent, e.createdAt, e.createdAt);
      n++;
    }
    db.exec("COMMIT");
    if (n !== entries.length) throw new Error("seed count mismatch");
  } finally {
    db.close();
  }
}
