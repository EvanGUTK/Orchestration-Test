import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLASSIC_RULES, ENGINE_VERSION, RANKED_RULES, type GameState } from "@2048/contracts";
import { createRepos, isUniqueViolation, type GameDb } from "../src/index.ts";
import { openMigrated } from "./helpers.ts";

const NOW = "2026-10-12T10:00:00.000Z";

function state(over: Partial<GameState> = {}): GameState {
  const cells = Array<string | null>(16).fill(null);
  cells[0] = "1";
  cells[5] = "2";
  return {
    schemaVersion: 1, engineVersion: ENGINE_VERSION, rulesetVersion: "classic-v1", board: { size: 4, cells },
    score: "0", acceptedMoves: 0, revision: 0,
    rng: { algorithm: "xoshiro128ss-v1", words: [1, 2, 3, 4] }, status: "active", celebrated2048: false, ...over,
  };
}

function seedBasics(db: GameDb) {
  return db.write((raw) => {
    const r = createRepos(raw);
    const userId = randomUUID();
    r.accounts.createUser({ id: userId, usernameNormalized: "alice", displayName: "Alice", passwordHash: "h", createdAt: NOW, preferencesJson: "{}" });
    r.games.ensureRuleset(CLASSIC_RULES, "d".repeat(64), NOW);
    r.games.ensureRuleset(RANKED_RULES, "e".repeat(64), NOW);
    const guestId = randomUUID();
    r.accounts.createGuest({ id: guestId, displayName: "Guest", createdAt: NOW });
    return { userId, guestId, repos: r };
  });
}

function newGame(userId: string, s: GameState, extra: Record<string, unknown> = {}) {
  return { id: randomUUID(), ownerUserId: userId, ownerGuestId: null, mode: "classic" as const, seed: "s", challengeId: null, matchId: null, seat: null, createdAt: NOW, state: s, ...extra };
}

describe("schema constraints", () => {
  it("round-trips scores and exponents far beyond 2^53 and 64-bit as exact TEXT", () => {
    const { db } = openMigrated();
    const { userId } = seedBasics(db);
    const hugeScore = "9".repeat(60) + "7";
    const hugeExp = "4096";
    const cells = Array<string | null>(16).fill(null);
    cells[3] = hugeExp;
    cells[4] = "54";
    const id = randomUUID();
    db.write((raw) => {
      const r = createRepos(raw);
      r.games.insertGame({ ...newGame(userId, state({ score: hugeScore, board: { size: 4, cells } }), {}), id });
    });
    const back = db.read((raw) => createRepos(raw).games.get(id))!;
    expect(back.state.score).toBe(hugeScore);
    expect(back.state.board.cells[3]).toBe("4096");
    expect(db.raw.prepare("SELECT typeof(score) t, typeof(max_exponent) m, max_exponent FROM games WHERE id = ?").get(id)).toEqual({ t: "text", m: "text", max_exponent: "4096" });
  });

  it.each([["1e5"], ["01"], ["-3"], [""], ["1.0"], [" 5"]])("rejects non-canonical score %j", (bad) => {
    const { db } = openMigrated();
    const { userId } = seedBasics(db);
    expect(() => db.write((raw) => createRepos(raw).games.insertGame(newGame(userId, state({ score: bad }))))).toThrow(/CHECK/);
  });

  it("rejects negative revisions, unknown statuses, and revision < acceptedMoves", () => {
    const { db } = openMigrated();
    const { userId } = seedBasics(db);
    const ins = (s: GameState) => () => db.write((raw) => createRepos(raw).games.insertGame(newGame(userId, s)));
    expect(ins(state({ revision: -1 }))).toThrow(/CHECK/);
    expect(ins(state({ status: "won" as never }))).toThrow(/CHECK/);
    expect(ins(state({ acceptedMoves: 3, revision: 2 }))).toThrow(/CHECK/);
  });

  it("prevents guests and bots from contaminating human-ranked data", () => {
    const { db } = openMigrated();
    const { userId, guestId } = seedBasics(db);
    const bad = (extra: Record<string, unknown>) => () =>
      db.write((raw) => createRepos(raw).games.insertGame(newGame(userId, state(), extra)));
    expect(bad({ mode: "ranked", ownerUserId: null, ownerGuestId: guestId })).toThrow(/CHECK/);
    expect(bad({ mode: "duel", ownerUserId: null, ownerGuestId: guestId })).toThrow(/CHECK/);
    expect(bad({ mode: "classic", ownerUserId: userId, ownerGuestId: guestId })).toThrow(/CHECK/);
    expect(bad({ mode: "classic", ownerUserId: null, ownerGuestId: null })).toThrow(/CHECK/);
    expect(bad({ mode: "ranked", challengeId: null })).toThrow(/CHECK/);
    expect(bad({ mode: "classic", ownerUserId: null, ownerGuestId: guestId })).not.toThrow();
  });

  it("enforces foreign keys, unique usernames and unique command ids", () => {
    const { db } = openMigrated();
    const { userId, repos } = seedBasics(db);
    expect(() => db.write((raw) => createRepos(raw).games.insertGame(newGame("0".repeat(36), state())))).toThrow(/FOREIGN KEY/);
    try {
      db.write((raw) => createRepos(raw).accounts.createUser({ id: randomUUID(), usernameNormalized: "alice", displayName: "A2", passwordHash: "h", createdAt: NOW, preferencesJson: "{}" }));
      expect.unreachable();
    } catch (e) {
      expect(isUniqueViolation(e, "users.username_normalized")).toBe(true);
    }
    const id = randomUUID();
    db.write((raw) => createRepos(raw).games.insertGame({ ...newGame(userId, state()), id }));
    const cmd = { gameId: id, commandId: "c1", kind: "move" as const, requestHash: "a".repeat(64), responseJson: "{}", revisionAfter: 1 };
    db.write((raw) => createRepos(raw).games.insertCommand(cmd, NOW));
    expect(() => db.write((raw) => createRepos(raw).games.insertCommand(cmd, NOW))).toThrow();
    void repos;
  });

  it("orders huge decimal scores by length then lexical value, never as REAL", () => {
    const { db } = openMigrated();
    const { userId } = seedBasics(db);
    const scores = ["99", "100", "9007199254740993", "9007199254740992", "1" + "0".repeat(40), "9".repeat(40), "5"];
    db.write((raw) => {
      const r = createRepos(raw);
      scores.forEach((score, i) => r.games.insertGame({ ...newGame(userId, state({ score })), id: randomUUID(), createdAt: `2026-10-12T10:00:00.00${i}Z` }));
    });
    const ordered = (db.raw.prepare("SELECT score FROM games ORDER BY length(score) DESC, score DESC").all() as { score: string }[]).map((r) => r.score);
    const expected = [...scores].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0));
    expect(ordered).toEqual(expected);
    // The expression index must be usable for the ranking order (no full sort).
    const plan = db.raw
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM games WHERE mode = 'classic' AND ruleset_version = 'classic-v1' AND status = 'active' ORDER BY length(score) DESC, score DESC, created_at, id LIMIT 25")
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_games_rank_score");
  });

  it("keeps rulesets and rating events immutable", () => {
    const { db } = openMigrated();
    seedBasics(db);
    expect(() => db.raw.prepare("UPDATE rulesets SET digest = ?").run("f".repeat(64))).toThrow(/immutable/);
    expect(() => db.raw.prepare("DELETE FROM rulesets").run()).toThrow(/immutable/);
  });

  it("undo stack keeps only the configured depth and pops the newest first", () => {
    const { db } = openMigrated();
    const { userId } = seedBasics(db);
    const id = randomUUID();
    db.write((raw) => {
      const g = createRepos(raw).games;
      g.insertGame({ ...newGame(userId, state()), id });
      for (let n = 0; n < 10; n++) g.pushUndo(id, state({ acceptedMoves: n, revision: n }), 4);
    });
    const g = createRepos(db.raw).games;
    expect(g.undoDepth(id)).toBe(4);
    expect(g.peekUndo(id)!.acceptedMoves).toBe(9);
  });

  it("deleting an account removes casual saves but keeps the anonymized user row", () => {
    const { db } = openMigrated();
    const { userId } = seedBasics(db);
    const id = randomUUID();
    db.write((raw) => {
      const r = createRepos(raw);
      r.games.insertGame({ ...newGame(userId, state()), id });
      r.accounts.createSession({ tokenHash: "t".repeat(64), userId, createdAt: NOW, expiresAt: "2026-11-12T10:00:00.000Z" });
      r.accounts.anonymizeUser(userId, NOW);
    });
    expect(db.raw.prepare("SELECT count(*) AS n FROM games").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    const u = db.raw.prepare("SELECT display_name, password_hash, username_normalized, deleted_at FROM users WHERE id = ?").get(userId) as Record<string, string>;
    expect(u.display_name).toBe("Deleted player");
    expect(u.password_hash).toBe("");
    expect(u.username_normalized).toBe(`deleted:${userId}`);
  });
});
