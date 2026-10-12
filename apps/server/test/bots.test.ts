import { describe, expect, it } from "vitest";
import { replay, newGame, stateChecksum } from "@2048/engine";
import { CLASSIC_RULES, DUEL_RULES, type BotConfig, type BotRunView, type Direction, type EventsPage, type GameView, type LeaderboardEntry, type Page } from "@2048/contracts";
import { Client, startApp, stopApp, until, type ErrorBody, type TestEnv } from "./helpers.ts";

const CFG: BotConfig = { strategy: "greedy", seed: "lab-seed", nodeBudget: 200, timeBudgetMs: 50 };
const OCT = () => new Date("2026-10-15T12:00:00.000Z");

async function user(t: TestEnv, name: string, speed: "fast" | "normal" | "slow" = "fast"): Promise<Client> {
  const c = new Client(t.app);
  expect((await c.register(name)).status).toBe(201);
  expect((await c.patch("/profile", { preferences: { botSpeed: speed } })).status).toBe(200);
  return c;
}

const runView = async (c: Client, id: string) => (await c.get<BotRunView>(`/bots/runs/${id}`)).body;
const game = async (c: Client, id: string) => (await c.get<GameView>(`/games/${id}`)).body;

describe("bot runs", { timeout: 90_000 }, () => {
  it("runs an exhibition game in a worker, persisting every move through the authoritative engine", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "bot_owner");
    const start = await c.post<BotRunView>("/bots/runs", { config: CFG, mode: "exhibition", maxMoves: 40, gameSeed: "exh-1" });
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ status: "running", botVersion: "bots-1.0.0", config: CFG, moves: expect.any(Number) });
    const done = await until(() => runView(c, start.body.id), (r) => r.status === "finished");
    expect(done.moves).toBe(40);
    expect(done.lastExplanation).toBeTruthy();
    const g = await game(c, done.gameId!);
    expect(g).toMatchObject({ mode: "bot-exhibition", rulesetVersion: "classic-v1", seed: "exh-1" });
    expect(g.state.acceptedMoves).toBe(40);
    expect(g.state.status).toBe("completed"); // the run ended within budget
    // The persisted move log re-executes on the pure engine to the same checksum (no client/bot claim is trusted).
    const ev = (await c.get<EventsPage>(`/games/${g.id}/events?limit=100`)).body;
    expect(ev.events).toHaveLength(40);
    const dirs = ev.events.map((e) => e.direction as Direction);
    const re = replay(newGame(CLASSIC_RULES, "exh-1"), dirs, CLASSIC_RULES);
    expect(re.steps[re.steps.length - 1]!.checksum).toBe(ev.events[39]!.checksum);
    expect(re.state.score).toBe(g.state.score);
    expect(t.db.raw.prepare("SELECT status, moves FROM bot_runs WHERE id = ?").get(start.body.id)).toEqual({ status: "finished", moves: 40 });
  });

  it("supports pause, step, resume and idempotent cancel; cancelling abandons the game", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "controller");
    // A deliberately slow searcher (about 100ms per move) so the controls act on a run that is still going.
    const slow: BotConfig = { strategy: "expectimax", seed: "ctl", nodeBudget: 2_000_000, timeBudgetMs: 100 };
    const start = await c.post<BotRunView>("/bots/runs", { config: slow, mode: "exhibition", maxMoves: 2000, gameSeed: "ctl" });
    const id = start.body.id;
    const paused = await c.post<BotRunView>(`/bots/runs/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("paused");
    await new Promise((r) => setTimeout(r, 300));
    const frozen = (await runView(c, id)).moves;
    await new Promise((r) => setTimeout(r, 300));
    expect((await runView(c, id)).moves).toBe(frozen); // really stopped
    expect((await c.post<BotRunView>(`/bots/runs/${id}/pause`)).body.status).toBe("paused"); // idempotent
    const stepped = await c.post<BotRunView>(`/bots/runs/${id}/step`);
    expect(stepped.status).toBe(200);
    const after = await until(() => runView(c, id), (r) => r.moves === frozen + 1);
    expect(after.status).toBe("paused");
    await new Promise((r) => setTimeout(r, 200));
    expect((await runView(c, id)).moves).toBe(frozen + 1); // exactly one move per step
    expect((await c.post<BotRunView>(`/bots/runs/${id}/resume`)).body.status).toBe("running");
    await until(() => runView(c, id), (r) => r.moves > frozen + 3);
    const c1 = await c.post<BotRunView>(`/bots/runs/${id}/cancel`);
    expect(c1.status).toBe(200);
    const end = await until(() => runView(c, id), (r) => r.status === "cancelled");
    expect((await c.post<BotRunView>(`/bots/runs/${id}/cancel`)).body.status).toBe("cancelled");
    expect((await c.post<BotRunView>(`/bots/runs/${id}/resume`)).body.status).toBe("cancelled"); // terminal states are sticky
    expect((await game(c, end.gameId!)).state.status).toBe("forfeited");
    // abandoned games are not on the bot board
    expect((await c.get<Page<LeaderboardEntry>>("/leaderboards?kind=bot&ruleset=classic-v1")).body.items).toEqual([]);
  });

  it("paces exhibition moves by the owner's bot speed preference", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "slow_bot", "slow");
    const start = await c.post<BotRunView>("/bots/runs", { config: CFG, mode: "exhibition", maxMoves: 6, gameSeed: "pace" });
    expect(t.db.raw.prepare("SELECT pace_ms FROM bot_runs WHERE id = ?").get(start.body.id)).toEqual({ pace_ms: 600 });
    await new Promise((r) => setTimeout(r, 1200));
    const mid = (await runView(c, start.body.id)).moves;
    expect(mid).toBeGreaterThanOrEqual(1);
    expect(mid).toBeLessThan(6); // a fast bot would be done by now
    // stepping while paused advances exactly one move regardless of pace
    await c.post(`/bots/runs/${start.body.id}/pause`);
    await new Promise((r) => setTimeout(r, 800));
    const p = (await runView(c, start.body.id)).moves;
    await c.post(`/bots/runs/${start.body.id}/step`);
    await until(() => runView(c, start.body.id), (r) => r.moves === p + 1);
    await c.post(`/bots/runs/${start.body.id}/cancel`);
  });

  it("validates budgets and enforces ownership, guest limits and concurrency caps", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "limits");
    const other = await user(t, "other_owner");
    const bad = async (body: Record<string, unknown>) => (await c.post<ErrorBody>("/bots/runs", body)).status;
    expect(await bad({ config: { ...CFG, nodeBudget: 0 }, mode: "exhibition" })).toBe(400);
    expect(await bad({ config: { ...CFG, nodeBudget: 9_000_000 }, mode: "exhibition" })).toBe(400);
    expect(await bad({ config: { ...CFG, strategy: "llm" }, mode: "exhibition" })).toBe(400);
    expect(await bad({ config: { ...CFG, timeBudgetMs: 0 }, mode: "exhibition" })).toBe(400);
    expect(await bad({ config: CFG, mode: "exhibition", boardSize: 9 })).toBe(400);
    expect(await bad({ config: CFG, mode: "exhibition", maxMoves: 10_000_000 })).toBe(400);
    expect(await bad({ config: CFG, mode: "league", boardSize: 5 })).toBe(400);
    expect(await bad({ config: CFG, mode: "turbo" })).toBe(400);
    const guest = new Client(t.app);
    await guest.guest();
    expect((await guest.post("/bots/runs", { config: CFG, mode: "league" })).status).toBe(403);
    const g = await guest.post<BotRunView>("/bots/runs", { config: CFG, mode: "exhibition", maxMoves: 5 });
    expect(g.status).toBe(201);
    // ownership
    const mine = (await c.post<BotRunView>("/bots/runs", { config: CFG, mode: "exhibition", maxMoves: 1000, boardSize: 5 })).body;
    expect((await other.get(`/bots/runs/${mine.id}`)).status).toBe(404);
    expect((await other.post(`/bots/runs/${mine.id}/cancel`)).status).toBe(404);
    expect((await c.get(`/bots/runs/${mine.id}`)).status).toBe(200);
    expect((await game(c, mine.gameId!)).state.board.size).toBe(5);
    // per-owner cap of 3 active runs
    const runs = [mine.id];
    for (let i = 0; i < 2; i++) runs.push((await c.post<BotRunView>("/bots/runs", { config: CFG, mode: "exhibition", maxMoves: 1000 })).body.id);
    const fourth = await c.post<ErrorBody>("/bots/runs", { config: CFG, mode: "exhibition", maxMoves: 1000 });
    expect(fourth.status).toBe(503);
    expect(fourth.body.error.code).toBe("RESOURCE_LIMIT");
    for (const id of runs) await c.post(`/bots/runs/${id}/cancel`);
    await until(() => Promise.all(runs.map((id) => runView(c, id))), (rs) => rs.every((r) => r.status === "cancelled"));
    expect((await c.post<BotRunView>("/bots/runs", { config: CFG, mode: "exhibition", maxMoves: 3 })).status).toBe(201);
  });

  it("league runs are repeatable: same seeds, version and budgets give identical results (BOT-04)", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "league_user");
    const cfg: BotConfig = { strategy: "heuristic", seed: "league-a", nodeBudget: 300, timeBudgetMs: 5 };
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await c.post<BotRunView>("/bots/runs", { config: cfg, mode: "league", gameSeed: "league-game-1" });
      expect(r.status).toBe(201);
      ids.push(r.body.id);
    }
    const done = await until(() => Promise.all(ids.map((id) => runView(c, id))), (rs) => rs.every((r) => r.status === "finished"), 80_000);
    const games = await Promise.all(done.map((r) => game(c, r.gameId!)));
    expect(games[0]!.rulesetVersion).toBe(DUEL_RULES.version);
    expect(games[0]!.state.acceptedMoves).toBeGreaterThan(0);
    expect(stateChecksum({ ...games[0]!.state, revision: 0, status: "active" })).toBe(stateChecksum({ ...games[1]!.state, revision: 0, status: "active" }));
    expect(games[0]!.state.score).toBe(games[1]!.state.score);
    // human Elo untouched, results visible on the bot board with version metadata in the run
    expect((await c.get<Page<LeaderboardEntry>>("/leaderboards?kind=duel-elo")).body.items).toEqual([]);
    const board = await c.get<Page<LeaderboardEntry>>("/leaderboards?kind=bot");
    expect(board.body.items).toHaveLength(2);
    expect(board.body.items[0]!.displayName).toBe("Heuristic search");
    expect(done[0]).toMatchObject({ botVersion: "bots-1.0.0", config: cfg });
  });

  it("rebuilds an in-progress run after a restart without double moves or a fake result (recovery)", async () => {
    const t = await startApp({}, undefined, { now: OCT });
    const c = await user(t, "recoverer", "slow");
    const start = await c.post<BotRunView>("/bots/runs", { config: CFG, mode: "exhibition", maxMoves: 8, gameSeed: "recover" });
    const id = start.body.id;
    const sid = c.cookies.get("sid")!;
    const mid = await until(() => runView(c, id), (r) => r.moves >= 2);
    await stopApp(t); // workers are stopped without recording a result
    expect(t.db.raw).toBeDefined();

    const t2 = await startApp({}, { dir: t.dir }, { now: OCT });
    const c2 = new Client(t2.app);
    c2.cookies.set("sid", sid);
    c2.csrf = (await c2.get("/auth/me")).body.csrfToken;
    const resumed = await runView(c2, id);
    expect(resumed.status).toBe("running"); // never silently counted as finished/cancelled
    expect(resumed.moves).toBeGreaterThanOrEqual(mid.moves);
    const done = await until(() => runView(c2, id), (r) => r.status === "finished", 60_000);
    expect(done.moves).toBe(8);
    const g = await game(c2, done.gameId!);
    expect(g.state.acceptedMoves).toBe(8);
    const ev = (await c2.get<EventsPage>(`/games/${g.id}/events`)).body;
    expect(ev.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // no gaps, no duplicates
    const re = replay(newGame(CLASSIC_RULES, "recover"), ev.events.map((e) => e.direction as Direction), CLASSIC_RULES);
    expect(re.steps.map((s) => s.checksum)).toEqual(ev.events.map((e) => e.checksum));
  });
});
