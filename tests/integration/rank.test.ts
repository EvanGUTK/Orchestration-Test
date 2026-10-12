// RANK-01 | Official challenge then retry — one official attempt/account/challenge; interrupted resume;
//           forfeit consumes the attempt.
// RANK-02 | Ranked undo / custom rule request — rejected; official rules/move cap enforced by server.
// RANK-03 | Mode/season/ruleset boards — human/bot/casual results separated; stable pagination;
//           decimal (numeric, not lexical) ordering of scores.
// Spec-first against CONTRACTS.md HTTP + api.ts (ChallengeSummary, LeaderboardEntry, Page).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, RULESETS } from "@g2048/contracts";
import type {
  ChallengeSummary,
  Direction,
  GameResponse,
  GameState,
  LeaderboardEntry,
} from "@g2048/contracts";
import { legalMoves, newGame } from "@g2048/engine";
import { createTestApp } from "./helpers/app.js";
import type { TestApp } from "./helpers/app.js";
import { cmd, createGame, getGame, legalMove, move, seedGameState, undo } from "./helpers/games.js";
import { Client, expectErrorEnvelope } from "./helpers/http.js";
import type { Res } from "./helpers/http.js";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

async function challenges(c: Client): Promise<ChallengeSummary[]> {
  const r = await c.get<{ items?: ChallengeSummary[] } | ChallengeSummary[]>("/challenges");
  expect(r.status, r.text).toBe(200);
  return Array.isArray(r.json) ? r.json : (r.json.items ?? []);
}
async function openChallenge(c: Client): Promise<ChallengeSummary> {
  const ch = (await challenges(c)).find((x) => x.status === "open");
  expect(ch, "the local catalog must offer an open challenge").toBeDefined();
  return ch as ChallengeSummary;
}
const attempt = (c: Client, id: string, body: unknown = {}) =>
  c.post<GameResponse>(`/challenges/${id}/attempts`, body);

/** Dead full 4x4 board (no merges) for seeded finished games. */
const DEAD = ["1", "2", "1", "2", "2", "1", "2", "1", "1", "2", "1", "2", "2", "1", "2", "1"];

describe("RANK-01 one official attempt per account and challenge", () => {
  it("start, resume after interruption (new session), then forfeit consumes the attempt", async () => {
    const a = new Client(t.app);
    await a.signUp("ranked_a");
    const ch = await openChallenge(a);
    expect(ch.rulesetVersion).toBe("ranked-v1");
    expect(ch.moveCap).toBe(500);

    const start = await attempt(a, ch.id);
    expect([200, 201], start.text).toContain(start.status);
    expect(start.json.game).toMatchObject({ mode: "ranked", rulesetVersion: "ranked-v1", status: "active" });
    expect(start.json.state.board.cells.filter((x) => x !== null)).toHaveLength(2);
    let s = start.json.state;
    for (let i = 0; i < 3; i++) s = await legalMove(a, start.json.game.id, s, i);

    // interrupted: a fresh login (new session) resumes the same official game
    const a2 = new Client(t.app);
    expect((await a2.login("ranked_a", "correct horse battery")).status).toBe(200);
    const resumed = await attempt(a2, ch.id);
    expect([200, 201]).toContain(resumed.status);
    expect(resumed.json.game.id).toBe(start.json.game.id);
    expect(resumed.json.state).toEqual(s);
    expect((await challenges(a2)).find((x) => x.id === ch.id)?.myAttempt).toEqual({
      status: "in-progress",
      gameId: start.json.game.id,
    });

    const ff = await a2.post(`/games/${start.json.game.id}/forfeit`, {
      commandId: cmd("ff"),
      expectedRevision: s.revision,
    });
    expect(ff.status, ff.text).toBe(200);
    expect((await challenges(a2)).find((x) => x.id === ch.id)?.myAttempt?.status).toBe("forfeited");
    const retry = await attempt(a2, ch.id);
    expect([403, 409], retry.text).toContain(retry.status);
    expectErrorEnvelope(retry);
    const n = t.db
      .prepare("SELECT COUNT(*) AS n FROM challenge_attempts WHERE challenge_id = ?")
      .get(ch.id) as { n: number };
    expect(n.n).toBe(1);
  });

  it("each account gets its own single attempt on the same challenge seed", async () => {
    const a = new Client(t.app);
    await a.signUp("ranked_b1");
    const b = new Client(t.app);
    await b.signUp("ranked_b2");
    const ch = await openChallenge(a);
    const ga = await attempt(a, ch.id);
    const gb = await attempt(b, ch.id);
    expect(ga.json.game.id).not.toBe(gb.json.game.id);
    expect(gb.json.state.board, "same challenge seed, same opening").toEqual(ga.json.state.board);
    expect([403, 404]).toContain((await b.get(`/games/${ga.json.game.id}`)).status);
  });

  it("guests cannot start official attempts", async () => {
    const owner = new Client(t.app);
    await owner.signUp("lister_r");
    const ch = await openChallenge(owner);
    const guest = new Client(t.app);
    const r = await attempt(guest, ch.id);
    expect([401, 403]).toContain(r.status);
    expectErrorEnvelope(r);
  });
});

describe("RANK-02 ranked rules are enforced by the server", () => {
  it("undo on a ranked game is 403 FORBIDDEN and changes nothing", async () => {
    const a = new Client(t.app);
    await a.signUp("ranked_undo");
    const g = await attempt(a, (await openChallenge(a)).id);
    const s = await legalMove(a, g.json.game.id, g.json.state);
    const u = await undo(a, g.json.game.id, s.revision);
    expect(u.status, u.text).toBe(403);
    expectErrorEnvelope(u, "FORBIDDEN");
    expect((await getGame(a, g.json.game.id)).state).toEqual(s);
  });

  it("custom rule requests cannot alter official rules; ranked mode cannot be created directly", async () => {
    const a = new Client(t.app);
    await a.signUp("ranked_rules");
    const ch = await openChallenge(a);
    const r = await attempt(a, ch.id, {
      rules: { moveCap: 100_000, undo: true, size: 8 },
      practice: { size: 8 },
    });
    if (r.status === 400) expectErrorEnvelope(r, "VALIDATION_ERROR");
    else {
      expect([200, 201], r.text).toContain(r.status);
      expect(r.json.state.rulesetVersion).toBe("ranked-v1");
      expect(r.json.state.board.size).toBe(4);
      expect(r.json.canUndo).toBe(false);
    }
    const direct = await a.post("/games", { mode: "ranked" });
    expect(direct.status).toBe(400);
    expectErrorEnvelope(direct, "VALIDATION_ERROR");
  });

  it("the 500-move cap completes the official game and records the server-derived official score", async () => {
    const a = new Client(t.app);
    await a.signUp("ranked_cap");
    const ch = await openChallenge(a);
    const g = await attempt(a, ch.id);
    const at499: GameState = { ...g.json.state, acceptedMoves: 499 };
    seedGameState(t.db, g.json.game.id, at499);
    const d = legalMoves(at499.board)[0] as Direction;
    const r = await move(a, g.json.game.id, d, at499.revision);
    expect(r.status, r.text).toBe(200);
    expect(r.json.state.acceptedMoves).toBe(500);
    expect(r.json.state.status).toBe("completed");
    const after = await move(
      a,
      g.json.game.id,
      legalMoves(r.json.state.board)[0] as Direction,
      r.json.state.revision,
    );
    expect([400, 403, 409], after.text).toContain(after.status);
    expectErrorEnvelope(after);
    expect((await getGame(a, g.json.game.id)).state).toEqual(r.json.state);
    const row = t.db
      .prepare("SELECT status, official_score FROM challenge_attempts WHERE game_id = ?")
      .get(g.json.game.id) as { status: string; official_score: string };
    expect(row).toEqual({ status: "completed", official_score: r.json.state.score });
  });
});

describe("RANK-03 separated boards, numeric decimal order, stable pagination", () => {
  async function finishedClassic(owner: Client, seed: string, score: string): Promise<string> {
    const g = await createGame(owner, { mode: "classic", seed });
    const base = newGame(RULESETS["classic-v1"], seed);
    seedGameState(t.db, g.game.id, { ...base, board: { size: 4, cells: DEAD }, score, status: "completed" });
    return g.game.id;
  }

  it("casual standings order scores numerically (length, then value) with a total stable order", async () => {
    const users = ["lb_one", "lb_two", "lb_three", "lb_four"].map(() => new Client(t.app));
    await users[0]!.signUp("lb_one");
    await users[1]!.signUp("lb_two");
    await users[2]!.signUp("lb_three");
    await users[3]!.signUp("lb_four");
    const g9 = await finishedClassic(users[0]!, "lb-9", "9");
    const g10a = await finishedClassic(users[1]!, "lb-10a", "10");
    const g10b = await finishedClassic(users[2]!, "lb-10b", "10");
    const gBig = await finishedClassic(users[3]!, "lb-big", "100000000000000000000");

    const seen: LeaderboardEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q = `/leaderboards?scope=casual&ruleset=classic-v1&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const r: Res<{ items: LeaderboardEntry[]; nextCursor: string | null }> = await users[0]!.get(q);
      expect(r.status, r.text).toBe(200);
      seen.push(...r.json.items);
      cursor = r.json.nextCursor;
      if (!cursor) break;
    }
    expect(seen.map((e) => e.gameId)).toEqual([gBig, g10a, g10b, g9]);
    expect(seen.map((e) => e.score)).toEqual(["100000000000000000000", "10", "10", "9"]);
    expect(seen.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(seen.every((e) => e.botStrategy === null)).toBe(true);
    const all = await users[0]!.get<{ items: LeaderboardEntry[] }>(
      "/leaderboards?scope=casual&ruleset=classic-v1&limit=100",
    );
    expect(all.json.items.map((e) => e.gameId)).toEqual([gBig, g10a, g10b, g9]);
  });

  it("challenge standings contain only human official attempts; limits are validated", async () => {
    const a = new Client(t.app);
    await a.signUp("lb_ranked");
    const ch = await openChallenge(a);
    const g = await attempt(a, ch.id);
    await a.post(`/games/${g.json.game.id}/forfeit`, { commandId: cmd("ff"), expectedRevision: 0 });
    await finishedClassic(a, "lb-casual-only", "99999");
    const r = await a.get<{ items: LeaderboardEntry[] }>(`/leaderboards?scope=challenge&challenge=${ch.id}`);
    expect(r.status, r.text).toBe(200);
    for (const e of r.json.items) {
      expect(e.botStrategy).toBeNull();
      expect(e.score).not.toBe("99999");
    }
    const tooBig = await a.get(`/leaderboards?scope=casual&limit=${LIMITS.listPageMax + 1}`);
    expect(tooBig.status).toBe(400);
    expectErrorEnvelope(tooBig, "VALIDATION_ERROR");
    const badScope = await a.get("/leaderboards?scope=everything");
    expect(badScope.status).toBe(400);
  });
});
