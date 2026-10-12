import { describe, expect, it } from "vitest";
import { legalMoves } from "@2048/engine";
import type { Challenge, GameView, LeaderboardEntry, MoveResponse, Page } from "@2048/contracts";
import { Client, cmd, startApp, type ErrorBody, type TestEnv } from "./helpers.ts";

const OCT = () => new Date("2026-10-15T12:00:00.000Z");
const NOV = () => new Date("2026-11-02T08:00:00.000Z");

async function user(t: TestEnv, name: string): Promise<Client> {
  const c = new Client(t.app);
  expect((await c.register(name)).status).toBe(201);
  return c;
}

async function firstChallenge(c: Client): Promise<Challenge> {
  const r = await c.get<Page<Challenge>>("/challenges");
  expect(r.status).toBe(200);
  return r.body.items[0]!;
}

/** Put a game right before its 500-move cap with a chosen score, then play the final accepted move. */
async function finishRanked(t: TestEnv, c: Client, game: GameView, score: string): Promise<MoveResponse & ErrorBody> {
  t.db.raw.prepare("UPDATE games SET accepted_moves = 499, revision = 499, score = ? WHERE id = ?").run(score, game.id);
  const fresh = (await c.get<GameView>(`/games/${game.id}`)).body;
  const dir = legalMoves(fresh.state.board)[0]!;
  const r = await c.post<MoveResponse & ErrorBody>(`/games/${game.id}/moves`, { commandId: cmd(), expectedRevision: 499, direction: dir });
  expect(r.status).toBe(200);
  return r.body;
}

describe("challenges and ranked attempts", { timeout: 60_000 }, () => {
  it("serves a local challenge catalog as a Page, public to readers and personalized for players", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const anon = await new Client(t.app).get<Page<Challenge>>("/challenges");
    expect(anon.status).toBe(200);
    expect(anon.body.items).toHaveLength(5);
    expect(anon.body.items.every((c) => c.seasonId === "s2026-10" && c.status === "open" && c.moveCap === 500 && c.rulesetVersion === "ranked-v1")).toBe(true);
    expect(anon.body.items.map((c) => c.id)).toEqual(["s2026-10-c1", "s2026-10-c2", "s2026-10-c3", "s2026-10-c4", "s2026-10-c5"]);
    expect(JSON.stringify(anon.body)).not.toMatch(/seed/i); // the seed is owned by the backend
    const page1 = await new Client(t.app).get<Page<Challenge>>("/challenges?limit=2");
    expect(page1.body.items).toHaveLength(2);
    const page2 = await new Client(t.app).get<Page<Challenge>>(`/challenges?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((c) => c.id)).toEqual(["s2026-10-c3", "s2026-10-c4"]);
    expect((await new Client(t.app).get("/challenges?limit=0")).status).toBe(400);
  });

  it("creates one official attempt, resumes it, and shares the seed between accounts without leaking it", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const a = await user(t, "ranker_a");
    const b = await user(t, "ranker_b");
    const ch = await firstChallenge(a);
    const r1 = await a.post<GameView>(`/challenges/${ch.id}/attempts`);
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ mode: "ranked", rulesetVersion: "ranked-v1", challengeId: ch.id, seed: null, undoAvailable: 0 });
    const r2 = await a.post<GameView>(`/challenges/${ch.id}/attempts`);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    const rb = await b.post<GameView>(`/challenges/${ch.id}/attempts`);
    expect(rb.body.id).not.toBe(r1.body.id);
    expect(rb.body.state.board).toEqual(r1.body.state.board); // same challenge seed => same opening
    expect((await a.get<Page<Challenge>>("/challenges")).body.items[0]!.myAttempt).toEqual({ gameId: r1.body.id, status: "active" });
    expect((await new Client(t.app).get<Page<Challenge>>("/challenges")).body.items[0]!.myAttempt).toBeUndefined();
    expect((await a.post("/challenges/nope/attempts")).status).toBe(404);
  });

  it("rejects guests, undo and custom rules on ranked games (server-enforced)", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const guest = new Client(t.app);
    await guest.guest();
    const ch = await firstChallenge(guest);
    const g = await guest.post<ErrorBody>(`/challenges/${ch.id}/attempts`);
    expect(g.status).toBe(403);
    expect(g.body.error.details).toEqual({ reason: "guest" });
    const u = await user(t, "no_undo");
    const game = (await u.post<GameView>(`/challenges/${ch.id}/attempts`)).body;
    const m = await u.post(`/games/${game.id}/moves`, { commandId: cmd(), expectedRevision: 0, direction: legalMoves(game.state.board)[0] });
    expect(m.status).toBe(200);
    const undo = await u.post(`/games/${game.id}/undo`, { commandId: cmd(), expectedRevision: 1 });
    expect(undo.status).toBe(403);
    expect((await u.post("/games", { mode: "ranked" })).status).toBe(400);
    expect((await u.post("/games", { mode: "practice", custom: { boardSize: 4 } }).then((r) => r.body.rulesetVersion))).toMatch(/^custom-v1/);
  });

  it("completes at the 500-move cap, consumes the attempt, and reveals the seed afterwards", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "capper");
    const ch = await firstChallenge(c);
    const game = (await c.post<GameView>(`/challenges/${ch.id}/attempts`)).body;
    const done = await finishRanked(t, c, game, "1000");
    expect(done.game.state.status).toBe("completed");
    expect(done.game.state.acceptedMoves).toBe(500);
    expect(done.game.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(done.events.some((e) => e.type === "move-cap" || e.type === "game-over")).toBe(true);
    const row = t.db.raw.prepare("SELECT status, official_score FROM challenge_attempts WHERE game_id = ?").get(game.id) as { status: string; official_score: string };
    expect(row.status).toBe("completed");
    expect(row.official_score).toBe(done.game.state.score);
    const retry = await c.post<ErrorBody>(`/challenges/${ch.id}/attempts`);
    expect(retry.status).toBe(403);
    expect(retry.body.error.details).toEqual({ reason: "attempt-consumed" });
    expect((await c.get<Page<Challenge>>("/challenges")).body.items[0]!.myAttempt?.status).toBe("completed");
    // moves on a finished attempt are rejected
    const more = await c.post(`/games/${game.id}/moves`, { commandId: cmd(), expectedRevision: done.sequence, direction: "left" });
    expect(more.status).toBe(403);
  });

  it("forfeiting consumes the attempt and it never appears in standings", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "quitter");
    const ch = await firstChallenge(c);
    const game = (await c.post<GameView>(`/challenges/${ch.id}/attempts`)).body;
    const f = await c.post<MoveResponse>(`/games/${game.id}/forfeit`, { commandId: cmd(), expectedRevision: 0 });
    expect(f.status).toBe(200);
    expect((await c.post(`/challenges/${ch.id}/attempts`)).status).toBe(403);
    expect((await c.get<Page<Challenge>>("/challenges")).body.items[0]!.myAttempt?.status).toBe("forfeited");
    const board = await c.get<Page<LeaderboardEntry>>(`/leaderboards?kind=challenge&challenge=${ch.id}`);
    expect(board.body.items).toEqual([]);
  });

  it("closes last month's challenges when the season rolls over and starts a fresh catalog", async () => {
    let now = OCT();
    const t = await startApp({}, undefined, { now: () => now });
    const c = await user(t, "seasonal");
    const old = await firstChallenge(c);
    const game = (await c.post<GameView>(`/challenges/${old.id}/attempts`)).body;
    now = NOV();
    const list = await c.get<Page<Challenge>>("/challenges");
    expect(list.body.items.every((x) => x.seasonId === "s2026-11" && x.status === "open")).toBe(true);
    const archived = await c.get<Page<Challenge>>("/challenges?season=s2026-10");
    expect(archived.body.items.every((x) => x.status === "closed")).toBe(true);
    // Abandoning forfeits: the interrupted attempt of the archived season was ended, and cannot be resumed.
    const late = await c.post<ErrorBody>(`/challenges/${old.id}/attempts`);
    expect(late.status).toBe(403);
    expect(late.body.error.details).toEqual({ reason: "challenge-closed" });
    const ended = (await c.get<GameView>(`/games/${game.id}`)).body;
    expect(ended.state.status).toBe("forfeited");
    expect(t.db.raw.prepare("SELECT status FROM challenge_attempts WHERE game_id = ?").get(game.id)).toEqual({ status: "forfeited" });
    // and a new-season attempt is allowed
    const fresh = await c.post<GameView>(`/challenges/${list.body.items[0]!.id}/attempts`);
    expect(fresh.status).toBe(201);
  });
});

describe("leaderboards", { timeout: 60_000 }, () => {
  async function attempt(t: TestEnv, name: string, chId: string, score: string, maxExp: string): Promise<{ c: Client; game: GameView; userId: string }> {
    const c = await user(t, name);
    const game = (await c.post<GameView>(`/challenges/${chId}/attempts`)).body;
    await finishRanked(t, c, game, "1");
    // Pin the official result so tie-break rules can be tested exactly.
    t.db.raw.prepare("UPDATE challenge_attempts SET official_score = ?, official_max_exponent = ? WHERE game_id = ?").run(score, maxExp, game.id);
    t.db.raw.prepare("UPDATE games SET score = ?, max_exponent = ? WHERE id = ?").run(score, maxExp, game.id);
    const me = await c.get("/auth/me");
    return { c, game, userId: me.body.userId };
  }

  it("orders challenge standings by exact score, max exponent, then attempt creation order, with stable pages", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const reader = new Client(t.app);
    const ch = await firstChallenge(reader);
    const huge = "9".repeat(45) + "1";
    const a = await attempt(t, "board_a", ch.id, "5000", "10");
    const b = await attempt(t, "board_b", ch.id, huge, "11");
    const c = await attempt(t, "board_c", ch.id, "5000", "10"); // ties with A: A created first
    const d = await attempt(t, "board_d", ch.id, "5000", "12"); // same score, higher exponent
    const e = await attempt(t, "board_e", ch.id, "49999", "9"); // 5 digits beats 4 digits regardless of lexical
    const q = (extra = "") => `/leaderboards?kind=challenge&challenge=${ch.id}${extra}`;
    const full = await reader.get<Page<LeaderboardEntry>>(q());
    expect(full.status).toBe(200);
    expect(full.body.items.map((x) => x.score)).toEqual([huge, "49999", "5000", "5000", "5000"]);
    expect(full.body.items.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(full.body.items.map((x) => x.accountId)).toEqual([b.userId, e.userId, d.userId, a.userId, c.userId]);
    expect(full.body.items[0]).toMatchObject({ maxExponent: "11", gameId: b.game.id, displayName: "board_b" });
    expect(full.body.nextCursor).toBeNull();

    const seen: LeaderboardEntry[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: { body: Page<LeaderboardEntry> } = await reader.get(q(`&limit=2${cursor ? `&cursor=${cursor}` : ""}`));
      seen.push(...p.body.items);
      cursor = p.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(full.body.items);

    // account filter keeps the rank within the whole board
    const mine = await reader.get<Page<LeaderboardEntry>>(q(`&account=${c.userId}`));
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ rank: 5, accountId: c.userId });
    // default challenge for the current season when none is named
    const dflt = await reader.get<Page<LeaderboardEntry>>("/leaderboards?kind=challenge");
    expect(dflt.status).toBe(200);
    expect((await reader.get(`/leaderboards?kind=challenge&challenge=nope`)).status).toBe(404);
    expect((await reader.get(q("&cursor=garbage"))).status).toBe(400);
    expect((await reader.get(q("&limit=101"))).status).toBe(400);
    expect((await reader.get("/leaderboards?kind=wrong")).status).toBe(400);
    expect((await reader.get(q("&account=not-a-uuid"))).status).toBe(400);
  });

  it("anonymizes deleted accounts but keeps their standing and replay valid", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const reader = new Client(t.app);
    const ch = await firstChallenge(reader);
    const a = await attempt(t, "stays_here", ch.id, "9000", "10");
    const b = await attempt(t, "will_leave", ch.id, "8000", "10");
    expect((await b.c.del("/profile", { password: "correct horse battery" })).status).toBe(200);
    const board = await reader.get<Page<LeaderboardEntry>>(`/leaderboards?kind=challenge&challenge=${ch.id}`);
    expect(board.body.items.map((x) => [x.rank, x.displayName, x.accountId])).toEqual([
      [1, "stays_here", a.userId],
      [2, "Deleted player", null],
    ]);
    expect(JSON.stringify(board.body)).not.toContain("will_leave");
    // the ranked game survives anonymization
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM games WHERE id = ?").get(b.game.id)).toEqual({ n: 1 });
  });

  it("keeps casual, practice and bot results on separate boards with exact decimal ordering", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const reader = new Client(t.app);
    const p1 = await user(t, "casual_a");
    const p2 = await user(t, "casual_b");
    const set = (id: string, score: string, exp: string) =>
      t.db.raw.prepare("UPDATE games SET score = ?, max_exponent = ? WHERE id = ?").run(score, exp, id);
    const mk = async (c: Client, body: Record<string, unknown> = { mode: "classic" }) => (await c.post<GameView>("/games", body)).body;
    const g1 = await mk(p1);
    const g2 = await mk(p1); // second, better game of the same account
    const g3 = await mk(p2);
    const practice = await mk(p2, { mode: "practice", custom: { boardSize: 5 } });
    set(g1.id, "99", "6");
    set(g2.id, "100", "6");
    set(g3.id, "12345678901234567890123", "40");
    set(practice.id, "99999999999999999999999999", "50");
    // only finished games are results; a game still in progress is not on the board yet
    expect((await reader.get<Page<LeaderboardEntry>>("/leaderboards?kind=casual")).body.items).toEqual([]);
    t.db.raw.prepare("UPDATE games SET status = 'completed' WHERE id IN (?, ?, ?, ?)").run(g1.id, g2.id, g3.id, practice.id);
    const board = await reader.get<Page<LeaderboardEntry>>("/leaderboards?kind=casual");
    expect(board.body.items.map((x) => [x.rank, x.displayName, x.score, x.gameId])).toEqual([
      [1, "casual_b", "12345678901234567890123", g3.id],
      [2, "casual_a", "100", g2.id],
      [3, "casual_a", "99", g1.id],
    ]);
    const mineOnly = await reader.get<Page<LeaderboardEntry>>(`/leaderboards?kind=casual&account=${board.body.items[1]!.accountId}`);
    expect(mineOnly.body.items.map((x) => [x.rank, x.score])).toEqual([[2, "100"], [3, "99"]]);
    expect((await reader.get<Page<LeaderboardEntry>>("/leaderboards?kind=bot")).body.items).toEqual([]);
    expect((await reader.get<Page<LeaderboardEntry>>("/leaderboards?kind=duel-elo")).body.items).toEqual([]);
    const other = await reader.get<Page<LeaderboardEntry>>("/leaderboards?kind=casual&ruleset=custom-v1:5:1:2:none");
    expect(other.body.items).toEqual([]); // practice rulesets are never on a human board
    const bySeason = await reader.get<Page<LeaderboardEntry>>("/leaderboards?kind=casual&season=s2026-09");
    expect(bySeason.body.items).toEqual([]);
    expect((await reader.get("/leaderboards?kind=casual&season=2026-10")).status).toBe(400);
  });
});

describe("profile statistics and export", { timeout: 60_000 }, () => {
  it("reports personal bests, distributions, ranked history and never leaks credentials in the export", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "exporter");
    const g = (await c.post<GameView>("/games", { mode: "classic" })).body;
    t.db.raw.prepare("UPDATE games SET score = '123456', max_exponent = '9' WHERE id = ?").run(g.id);
    const ch = await firstChallenge(c);
    const ranked = (await c.post<GameView>(`/challenges/${ch.id}/attempts`)).body;
    await finishRanked(t, c, ranked, "7777");
    const stats = await c.get("/profile/stats");
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({
      gamesPlayed: 2, bestScore: "123456", bestScoreGameId: g.id,
      scoreDistribution: [{ bucketLabel: "6-digit scores", count: 1 }],
      duels: { won: 0, drawn: 0, lost: 0, rating: null },
      bot: { runs: 0, byStrategy: {} },
    });
    expect(stats.body.rankedHistory).toHaveLength(1);
    expect(stats.body.rankedHistory[0]).toMatchObject({ challengeId: ch.id, gameId: ranked.id, rank: 1 });

    const exp = await c.get("/profile/export");
    expect(exp.status).toBe(200);
    expect(String(exp.headers["content-disposition"])).toMatch(/attachment/);
    const text = JSON.stringify(exp.body);
    expect(text).not.toMatch(/argon2|password|token|csrf|sid=|hash/i);
    expect(exp.body.account).toMatchObject({ username: "exporter" });
    expect(exp.body.games).toHaveLength(2);
    expect(exp.body.challengeAttempts).toHaveLength(1);
    expect(exp.body.games.find((x: { id: string }) => x.id === ranked.id).moves.length).toBeGreaterThan(0);
    expect((await new Client(t.app).get("/profile/export")).status).toBe(401);

    const guest = new Client(t.app);
    await guest.guest();
    expect((await guest.get("/profile/export")).status).toBe(403);
    expect((await guest.get("/profile/stats")).body.gamesPlayed).toBe(0);
  });
});
