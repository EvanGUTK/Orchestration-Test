import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/** Creates a private temporary directory for one test; never the configured DATABASE_PATH. */
export function makeTempDir(prefix = "g2048-db-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Best effort on Windows if a handle is still closing.
      }
    },
  };
}

const NOW = "2026-10-12T00:00:00.000Z";
const HASH = "0".repeat(64);
const BOARD = JSON.stringify({ size: 4, cells: Array.from({ length: 16 }, () => null) });
const RNG = JSON.stringify({ algorithm: "xoshiro128ss-v1", words: [1, 2, 3, 4] });

export function insertTestUser(db: DatabaseSync, username: string, id: string = randomUUID()): string {
  db.prepare(
    `INSERT INTO users (id, username_normalized, display_name, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, username, username, "$argon2id$test-placeholder-hash", NOW, NOW);
  return id;
}

export type TestGame = {
  id?: string;
  mode?: string;
  ruleset?: string;
  score?: unknown;
  ownerUserId?: string | null;
  ownerGuestId?: string | null;
  revision?: unknown;
  status?: string;
  maxExponent?: string | null;
  createdAt?: string;
};

export function insertTestGame(db: DatabaseSync, game: TestGame = {}): string {
  const id = game.id ?? randomUUID();
  const ruleset = game.ruleset ?? "classic-v1";
  const status = game.status ?? "active";
  db.prepare(
    `INSERT INTO games (id, owner_user_id, owner_guest_id, mode, ruleset_version, rules_json, engine_version, seed,
       board_size, board_json, rng_state, score, max_exponent, accepted_moves, revision, status, state_checksum,
       created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 'seed', 4, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    game.ownerUserId ?? null,
    game.ownerGuestId ?? null,
    game.mode ?? "classic",
    ruleset,
    JSON.stringify({ version: ruleset }),
    BOARD,
    RNG,
    game.score === undefined ? "0" : (game.score as string),
    game.maxExponent ?? null,
    game.revision === undefined ? 0 : (game.revision as number),
    status,
    HASH,
    game.createdAt ?? NOW,
    NOW,
    status === "active" ? null : NOW,
  );
  return id;
}

export const TEST_NOW = NOW;
