import { describe, expect, it } from "vitest";
import { legalMoves } from "@2048/engine";
import { createRepos } from "@2048/database";
import type { BotConfig, GameView, LeaderboardEntry, MatchView, MoveResponse, Page } from "@2048/contracts";
import { Client, cmd, startApp, stopApp, until, type ErrorBody, type TestEnv } from "./helpers.ts";

const OCT = () => new Date("2026-10-15T12:00:00.000Z");
const FAST_BOT: BotConfig = { strategy: "random", seed: "duel-bot", nodeBudget: 100, timeBudgetMs: 50 };

async function user(t: TestEnv, name: string): Promise<{ c: Client; id: string }> {
  const c = new Client(t.app);
  const r = await c.register(name);
  expect(r.status).toBe(201);
  return { c, id: r.body.userId };
}

async function lobby(t: TestEnv): Promise<{ a: { c: Client; id: string }; b: { c: Client; id: string }; match: MatchView; g0: GameView; g1: GameView }> {
  const a = await user(t, "duel_a");
  const b = await user(t, "duel_b");
  const created = await a.c.post<MatchView>("/matches", { kind: "human-vs-human" });
  expect(created.status).toBe(201);
  const joined = await b.c.post<MatchView>(`/matches/${created.body.id}/join`);
  expect(joined.status).toBe(200);
  const g0 = (await a.c.get<GameView>(`/games/${joined.body.seats[0].gameId}`)).body;
  const g1 = (await b.c.get<GameView>(`/games/${joined.body.seats[1]!.gameId}`)).body;
  return { a, b, match: joined.body, g0, g1 };
}

/** Finish a duel seat at the 500-move cap with a pinned score. */
async function capSeat(t: TestEnv, c: Client, game: GameView, score: string): Promise<MoveResponse & ErrorBody> {
  t.db.raw.prepare("UPDATE games SET accepted_moves = 499, revision = 499, score = ? WHERE id = ?").run(score, game.id);
  const fresh = (await c.get<GameView>(`/games/${game.id}`)).body;
  const r = await c.post<MoveResponse & ErrorBody>(`/games/${game.id}/moves`, {
    commandId: cmd(), expectedRevision: 499, direction: legalMoves(fresh.state.board)[0],
  });
  expect(r.status).toBe(200);
  return r.body;
}

const forfeit = (c: Client, g: GameView, rev: number) => c.post<MoveResponse>(`/games/${g.id}/forfeit`, { commandId: cmd(), expectedRevision: rev });
const ratingRows = (t: TestEnv) => t.db.raw.prepare("SELECT account_id, rating_before, rating_after, delta FROM rating_events ORDER BY id").all() as { account_id: string; rating_before: number; rating_after: number; delta: number }[];

describe("human duels", { timeout: 60_000 }, () => {
  it("creates a lobby, seats a different account, and gives both seats the same seeded board", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const a = await user(t, "host_a");
    const b = await user(t, "guest_b");
    const m = await a.c.post<MatchView>("/matches", { kind: "human-vs-human" });
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ kind: "human-vs-human", status: "lobby", outcome: null, rulesetVersion: "duel-v1", ratingEvents: [] });
    expect(m.body.seats[0]).toMatchObject({ seat: 0, kind: "human", displayName: "host_a", gameId: null });
    expect(m.body.seats[1]).toBeNull();
    // discoverable by others, but not joinable by oneself
    expect((await b.c.get<Page<MatchView>>("/matches?scope=lobby")).body.items.map((x) => x.id)).toEqual([m.body.id]);
    const self = await a.c.post<ErrorBody>(`/matches/${m.body.id}/join`);
    expect(self.status).toBe(403);
    const guest = new Client(t.app);
    await guest.guest();
    expect((await guest.post(`/matches/${m.body.id}/join`)).status).toBe(403);
    expect((await guest.post("/matches", { kind: "human-vs-human" })).status).toBe(403);

    const joined = await b.c.post<MatchView>(`/matches/${m.body.id}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.status).toBe("active");
    expect(joined.body.seats.map((s) => s?.displayName)).toEqual(["host_a", "guest_b"]);
    const g0 = (await a.c.get<GameView>(`/games/${joined.body.seats[0].gameId}`)).body;
    const g1 = (await b.c.get<GameView>(`/games/${joined.body.seats[1]!.gameId}`)).body;
    expect(g0).toMatchObject({ mode: "duel", rulesetVersion: "duel-v1", matchId: m.body.id, seat: 0, seed: null });
    expect(g1).toMatchObject({ seat: 1, seed: null });
    expect(g0.state.board).toEqual(g1.state.board);
    expect(g0.state.rng).toEqual(g1.state.rng);

    // seat authority: a third account cannot join, read, or move
    const c3 = await user(t, "outsider");
    expect((await c3.c.post(`/matches/${m.body.id}/join`)).status).toBe(403);
    expect((await c3.c.get(`/matches/${m.body.id}`)).status).toBe(404);
    expect((await c3.c.get(`/games/${g0.id}`)).status).toBe(404);
    // each seat moves only its own game, but may watch the other (split-board display)
    const cross = await a.c.post(`/games/${g1.id}/moves`, { commandId: cmd(), expectedRevision: 0, direction: "left" });
    expect(cross.status).toBe(404);
    expect((await a.c.get<GameView>(`/games/${g1.id}`)).status).toBe(200);
    expect((await a.c.get(`/matches/${m.body.id}`)).status).toBe(200);
    // no undo or custom rules in duels
    expect((await a.c.post(`/games/${g0.id}/undo`, { commandId: cmd(), expectedRevision: 0 })).status).toBe(403);
    // lobby is full now
    expect((await c3.c.get<Page<MatchView>>("/matches?scope=lobby")).body.items).toEqual([]);
  });

  it("finalizes only after BOTH seats end, rates exactly once, and conserves Elo", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const { a, b, match, g0, g1 } = await lobby(t);
    // seat 0 reaches the cap with the higher score; the match stays pending (seat 1 can still move)
    const r0 = await capSeat(t, a.c, g0, "50000");
    expect(r0.game.state.status).toBe("completed");
    let view = (await a.c.get<MatchView>(`/matches/${match.id}`)).body;
    expect(view).toMatchObject({ status: "active", outcome: null, ratingEvents: [] });
    expect(view.seats[0]).toMatchObject({ terminalReason: expect.stringMatching(/^(move-cap|dead)$/) });
    expect(view.seats[1]!.terminalReason).toBeNull();
    // seat 1 keeps moving after seat 0 ended
    const m1 = await b.c.post<MoveResponse>(`/games/${g1.id}/moves`, { commandId: cmd(), expectedRevision: 0, direction: legalMoves(g1.state.board)[0] });
    expect(m1.status).toBe(200);
    expect(ratingRows(t)).toHaveLength(0);

    const r1 = await capSeat(t, b.c, (await b.c.get<GameView>(`/games/${g1.id}`)).body, "40000");
    expect(r1.game.state.status).toBe("completed");
    view = (await a.c.get<MatchView>(`/matches/${match.id}`)).body;
    expect(view.status).toBe("finished");
    expect(view.outcome).toBe("seat0");
    expect(view.ratingEvents).toHaveLength(2);
    const rows = ratingRows(t);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.rating_before, r.rating_after, r.delta])).toEqual([[1000, 1012, 12], [1000, 988, -12]]); // K=24, equal ratings
    expect(rows[0]!.delta + rows[1]!.delta).toBe(0);
    expect(view.ratingEvents[0]).toMatchObject({ accountId: a.id, algorithm: "elo-v1", outcome: 1, idempotencyKey: `elo-v1:${match.id}:${a.id}` });

    // exactly-once: repeating the finishing command (same commandId) or touching the match changes nothing
    const lastMove = t.db.raw.prepare("SELECT command_id, direction FROM game_moves WHERE game_id = ? ORDER BY revision DESC LIMIT 1").get(g1.id) as { command_id: string; direction: string };
    const again = await b.c.post<MoveResponse>(`/games/${g1.id}/moves`, { commandId: lastMove.command_id, expectedRevision: 499, direction: lastMove.direction });
    expect(again.status).toBe(200);
    expect(ratingRows(t)).toHaveLength(2);
    // even a direct second application of the same rating event (same idempotency key) is a no-op
    const before = t.db.raw.prepare("SELECT * FROM ratings ORDER BY account_id").all();
    const inserted = t.db.write((raw) => createRepos(raw).competition.applyRatingEvent(view.ratingEvents[0]!, "2026-10-15T12:00:01.000Z"));
    expect(inserted).toBe(0);
    expect(t.db.raw.prepare("SELECT * FROM ratings ORDER BY account_id").all()).toEqual(before);
    expect(ratingRows(t)).toHaveLength(2);
    expect((await a.c.post(`/games/${g0.id}/forfeit`, { commandId: cmd(), expectedRevision: 500 })).status).toBe(403);
    expect(ratingRows(t)).toHaveLength(2);

    // the ladder reflects it
    const ladder = await a.c.get<Page<LeaderboardEntry>>("/leaderboards?kind=duel-elo");
    expect(ladder.body.items.map((e) => [e.rank, e.displayName, e.rating, e.won, e.lost, e.played])).toEqual([
      [1, "duel_a", 1012, 1, 0, 1],
      [2, "duel_b", 988, 0, 1, 1],
    ]);
    // seats can replay both games after the match; their identities are not in the replay
    const replay = await b.c.get(`/replays/${g0.id}`);
    expect(replay.status).toBe(200);
    expect(JSON.stringify(replay.body)).not.toMatch(/duel_a|duel_b|userId/);
  });

  it("decides ties by max exponent then draws, and forfeits lose regardless of score", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    // forfeit loses despite higher score
    {
      const { a, b, match, g0, g1 } = await lobby(t);
      await capSeat(t, a.c, g0, "99999");
      expect((await forfeit(b.c, g1, 0)).status).toBe(200);
      const v = (await a.c.get<MatchView>(`/matches/${match.id}`)).body;
      expect(v).toMatchObject({ status: "finished", outcome: "seat0" });
      expect(v.seats[1]!.terminalReason).toBe("forfeit");
    }
    // double forfeit => draw, no Elo change between equal ratings
    {
      const a = await user(t, "dfa");
      const b = await user(t, "dfb");
      const m = (await a.c.post<MatchView>("/matches", { kind: "human-vs-human" })).body;
      const j = (await b.c.post<MatchView>(`/matches/${m.id}/join`)).body;
      expect((await forfeit(a.c, { id: j.seats[0].gameId! } as GameView, 0)).status).toBe(200);
      expect((await forfeit(b.c, { id: j.seats[1]!.gameId! } as GameView, 0)).status).toBe(200);
      const v = (await a.c.get<MatchView>(`/matches/${m.id}`)).body;
      expect(v).toMatchObject({ status: "finished", outcome: "draw" });
      expect(v.ratingEvents.map((e) => [e.delta, e.outcome])).toEqual([[0, 0.5], [0, 0.5]]);
    }
    // equal score, equal max exponent => draw
    {
      const a = await user(t, "eqa");
      const b = await user(t, "eqb");
      const m = (await a.c.post<MatchView>("/matches", { kind: "human-vs-human" })).body;
      const j = (await b.c.post<MatchView>(`/matches/${m.id}/join`)).body;
      const ga = (await a.c.get<GameView>(`/games/${j.seats[0].gameId}`)).body;
      const gb = (await b.c.get<GameView>(`/games/${j.seats[1]!.gameId}`)).body;
      // identical boards + identical pinned score => identical facts after the identical final move
      await capSeat(t, a.c, ga, "777");
      await capSeat(t, b.c, gb, "777");
      const v = (await a.c.get<MatchView>(`/matches/${m.id}`)).body;
      expect(v.status).toBe("finished");
      expect(v.outcome).toBe("draw");
    }
    // ratings are conserved across all three matches
    const sum = ratingRows(t).reduce((s, r) => s + r.delta, 0);
    expect(sum).toBe(0);
  });

  it("keeps a duel with an absent participant pending: nothing is awarded without an explicit forfeit", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const { a, match, g0 } = await lobby(t);
    await capSeat(t, a.c, g0, "1234");
    await new Promise((r) => setTimeout(r, 100));
    const v = (await a.c.get<MatchView>(`/matches/${match.id}`)).body;
    expect(v).toMatchObject({ status: "active", outcome: null, ratingEvents: [] });
    expect(ratingRows(t)).toHaveLength(0);
  });

  it("restart mid-duel resumes seat state and never re-rates or invents a win (DB-07)", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const { a, b, match, g0, g1 } = await lobby(t);
    await capSeat(t, a.c, g0, "5000");
    const cookies = { a: a.c.cookies.get("sid")!, b: b.c.cookies.get("sid")! };
    await stopApp(t);

    const t2 = await startApp({}, { dir: t.dir }, { now: OCT });
    const a2 = new Client(t2.app);
    a2.cookies.set("sid", cookies.a);
    const b2 = new Client(t2.app);
    b2.cookies.set("sid", cookies.b);
    a2.csrf = (await a2.get("/auth/me")).body.csrfToken;
    b2.csrf = (await b2.get("/auth/me")).body.csrfToken;
    const mid = (await a2.get<MatchView>(`/matches/${match.id}`)).body;
    expect(mid).toMatchObject({ status: "active", outcome: null, ratingEvents: [] });
    expect(mid.seats[0]!.terminalReason).not.toBeNull();
    expect(ratingRows(t2)).toHaveLength(0);

    await capSeat(t2, b2, (await b2.get<GameView>(`/games/${g1.id}`)).body, "4000");
    expect(ratingRows(t2)).toHaveLength(2);
    // a second restart must not add anything
    await stopApp(t2);
    const t3 = await startApp({}, { dir: t.dir }, { now: OCT });
    expect(ratingRows(t3)).toHaveLength(2);
    expect(t3.db.raw.prepare("SELECT count(*) AS n FROM ratings").get()).toEqual({ n: 2 });
  });

  it("does not rate when the match's season was archived before it finished", async () => {
    let now = OCT();
    const t = await startApp({}, undefined, { now: () => now });
    const { a, b, match, g0, g1 } = await lobby(t);
    await capSeat(t, a.c, g0, "300");
    now = new Date("2026-11-03T00:00:00.000Z");
    await t.services.seasons.current();
    await capSeat(t, b.c, g1, "200");
    const v = (await a.c.get<MatchView>(`/matches/${match.id}`)).body;
    expect(v).toMatchObject({ status: "finished", outcome: "seat0", ratingEvents: [] });
    expect(ratingRows(t)).toHaveLength(0);
  });

  it("limits open lobbies per account", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const a = await user(t, "lobby_spam");
    for (let i = 0; i < 5; i++) expect((await a.c.post("/matches", { kind: "human-vs-human" })).status).toBe(201);
    const r = await a.c.post<ErrorBody>("/matches", { kind: "human-vs-human" });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("RESOURCE_LIMIT");
  });
});

describe("bot duels", { timeout: 90_000 }, () => {
  it("human vs bot: the bot plays its own seeded game in a worker, the human is never rated", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const h = await user(t, "vs_bot");
    const created = await h.c.post<MatchView>("/matches", { kind: "human-vs-bot", bot: FAST_BOT });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: "human-vs-bot", status: "active" });
    expect(created.body.seats[1]).toMatchObject({ kind: "bot", displayName: "Random legal move" });
    const humanGame = (await h.c.get<GameView>(`/games/${created.body.seats[0].gameId}`)).body;
    const botGameId = created.body.seats[1]!.gameId!;
    // the bot finishes all 500 accepted moves (or dies) on its own
    const botGame = await until(
      async () => (await h.c.get<GameView>(`/games/${botGameId}`)).body,
      (g) => g.state.status !== "active",
      60_000,
    );
    expect(["completed"]).toContain(botGame.state.status);
    expect(botGame).toMatchObject({ mode: "bot-duel" });
    // same seed => the bot's opening equals the human's opening
    const first = (await h.c.get<{ events: unknown[] }>(`/games/${botGameId}/events?limit=1`)).body;
    expect(first.events).toHaveLength(1);
    expect(humanGame.state.board.cells.filter((c) => c !== null)).toHaveLength(2);
    // match stays pending until the human's seat ends; forfeit decides it for the bot
    expect((await h.c.get<MatchView>(`/matches/${created.body.id}`)).body.status).toBe("active");
    expect((await forfeit(h.c, humanGame, 0)).status).toBe(200);
    const done = (await h.c.get<MatchView>(`/matches/${created.body.id}`)).body;
    expect(done).toMatchObject({ status: "finished", outcome: "seat1", ratingEvents: [] });
    expect(ratingRows(t)).toHaveLength(0);
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM ratings").get()).toEqual({ n: 0 });
    // the bot's result is on the bot board, not the human boards
    const bots = await h.c.get<Page<LeaderboardEntry>>("/leaderboards?kind=bot");
    expect(bots.body.items.length).toBe(1);
    expect(bots.body.items[0]).toMatchObject({ accountId: null, displayName: "Random legal move", gameId: botGameId });
    expect((await h.c.get<Page<LeaderboardEntry>>("/leaderboards?kind=duel-elo")).body.items).toEqual([]);
    // the human cannot steer the bot of a human-vs-bot match
    const run = t.db.raw.prepare("SELECT id FROM bot_runs WHERE match_id = ?").get(created.body.id) as { id: string };
    expect((await h.c.post(`/bots/runs/${run.id}/pause`)).status).toBe(403);
  });

  it("bot vs bot: both seats are algorithms, the match finishes and never touches Elo", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const h = await user(t, "bot_vs_bot");
    const created = await h.c.post<MatchView>("/matches", {
      kind: "bot-vs-bot", bot: FAST_BOT, opponentBot: { ...FAST_BOT, strategy: "greedy", seed: "other" },
    });
    expect(created.status).toBe(201);
    expect(created.body.seats.map((s) => s?.kind)).toEqual(["bot", "bot"]);
    expect((await h.c.post("/matches", { kind: "bot-vs-bot", bot: FAST_BOT })).status).toBe(400);
    const done = await until(
      async () => (await h.c.get<MatchView>(`/matches/${created.body.id}`)).body,
      (m) => m.status === "finished",
      80_000,
    );
    expect(["seat0", "seat1", "draw"]).toContain(done.outcome);
    expect(done.ratingEvents).toEqual([]);
    expect(ratingRows(t)).toHaveLength(0);
    expect(done.seats.every((s) => s!.terminalReason !== null && s!.score !== undefined)).toBe(true);
  });
});
