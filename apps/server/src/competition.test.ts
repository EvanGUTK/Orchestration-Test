import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIMITS,
  RULESETS,
  practiceRuleset,
  type BotRunView,
  type ChallengeSummary,
  type Direction,
  type GameResponse,
  type GameState,
  type LeaderboardEntry,
  type MoveResponse,
  type Page,
  type ReplayFile,
} from "@g2048/contracts";
import { gamesRepo } from "@g2048/database";
import { applyMove, checksum, legalMoves, maxExponent, newGame, verifyReplay } from "@g2048/engine";
import { removeDir, startTestServer, TestClient, type TestServer } from "./test-support.js";

const servers: TestServer[] = [];
async function server(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(options);
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.close();
    removeDir(s.dir);
  }
});

let counter = 0;
const cid = () => `comp-${String((counter += 1)).padStart(7, "0")}`;
const PASSWORD = "correct horse battery";
const DEAD = ["1", "2", "1", "2", "2", "1", "2", "1", "1", "2", "1", "2", "2", "1", "2", "1"];

type ErrorBody = { error: { code: string } };
function expectError(
  res: { statusCode: number; json: () => unknown; body: string },
  status: number,
  code: string,
) {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as ErrorBody).error.code).toBe(code);
}

async function signedIn(app: TestServer["app"], name: string, displayName = name): Promise<TestClient> {
  const c = new TestClient(app);
  expect((await c.register(name, PASSWORD, displayName)).statusCode).toBe(201);
  return c;
}

const userIdOf = (s: TestServer, name: string) =>
  (s.db.prepare("SELECT id FROM users WHERE username_normalized = ?").get(name) as { id: string }).id;

/** Plays `n` changing moves through the API (state from responses; works for redacted states too). */
async function play(c: TestClient, id: string, board: GameState["board"], revision: number, n: number) {
  let b = board;
  let rev = revision;
  let last: MoveResponse | null = null;
  for (let i = 0; i < n; i += 1) {
    const legal = legalMoves(b);
    const direction = legal[i % legal.length] as Direction;
    const res = await c.request("POST", `/games/${id}/moves`, {
      commandId: cid(),
      expectedRevision: rev,
      direction,
    });
    expect(res.statusCode, res.body).toBe(200);
    last = res.json() as MoveResponse;
    b = last.state.board;
    rev = last.state.revision;
    if (last.state.status !== "active") break;
  }
  return last as MoveResponse;
}

/** TEST-ONLY: overwrite a game's current state (keeps the row consistent with its checksum). */
function force(s: TestServer, id: string, state: GameState): void {
  const rev = (s.db.prepare("SELECT revision FROM games WHERE id = ?").get(id) as { revision: number })
    .revision;
  gamesRepo.updateState(
    s.db,
    id,
    rev,
    state,
    checksum(state),
    maxExponent(state.board),
    new Date().toISOString(),
  );
}

async function challenges(c: TestClient): Promise<ChallengeSummary[]> {
  const res = await c.request("GET", "/challenges");
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as Page<ChallengeSummary>).items;
}

describe("RANK-01/02 challenges and official attempts", () => {
  it("seeds ranked + duel seasons and a deterministic open catalog", async () => {
    const s = await server();
    const seasons = s.db.prepare("SELECT id, ruleset_version, status FROM seasons ORDER BY id").all();
    expect(seasons).toEqual([
      { id: "duel-s1", ruleset_version: "duel-v1", status: "active" },
      { id: "s1", ruleset_version: "ranked-v1", status: "active" },
    ]);
    const guest = new TestClient(s.app);
    await guest.me();
    const list = await challenges(guest);
    expect(list).toHaveLength(10);
    expect(list[0]).toEqual({
      id: "ch-s1-1",
      season: "s1",
      rulesetVersion: "ranked-v1",
      moveCap: 500,
      status: "open",
      myAttempt: null,
    });
    expect(list.map((c) => c.id).slice(0, 3)).toEqual(["ch-s1-1", "ch-s1-2", "ch-s1-3"]);
  });

  it("start (201), resume from a new session (200), forfeit consumes; one row; guests 403", async () => {
    const s = await server();
    const a = await signedIn(s.app, "ranked_a");
    const start = await a.request("POST", "/challenges/ch-s1-1/attempts", {
      rules: { moveCap: 99999, undo: true },
      score: "1",
    });
    expect(start.statusCode, start.body).toBe(201);
    const game = start.json() as GameResponse & { attempt: { status: string; gameId: string } };
    expect(game.game).toMatchObject({ mode: "ranked", rulesetVersion: "ranked-v1", status: "active" });
    expect(game.state).not.toHaveProperty("rng");
    expect(game.canUndo).toBe(false);
    expect(game.state.board).toEqual(newGame(RULESETS["ranked-v1"], "challenge:s1:1").board);
    const after = await play(a, game.game.id, game.state.board, 0, 3);

    const a2 = new TestClient(s.app);
    expect((await a2.login("ranked_a", PASSWORD)).statusCode).toBe(200);
    const resumed = await a2.request("POST", "/challenges/ch-s1-1/attempts", {});
    expect(resumed.statusCode).toBe(200);
    expect((resumed.json() as GameResponse).state).toEqual(after.state);
    expect((await challenges(a2)).find((c) => c.id === "ch-s1-1")?.myAttempt).toEqual({
      status: "in-progress",
      gameId: game.game.id,
    });

    expectError(
      await a2.request("POST", `/games/${game.game.id}/undo`, { commandId: cid(), expectedRevision: 3 }),
      403,
      "FORBIDDEN",
    );
    const ff = await a2.request("POST", `/games/${game.game.id}/forfeit`, {
      commandId: cid(),
      expectedRevision: 3,
    });
    expect(ff.statusCode, ff.body).toBe(200);
    expect((await challenges(a2)).find((c) => c.id === "ch-s1-1")?.myAttempt?.status).toBe("forfeited");
    expectError(await a2.request("POST", "/challenges/ch-s1-1/attempts", {}), 403, "FORBIDDEN");
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM challenge_attempts").get()).toEqual({ n: 1 });

    const guest = new TestClient(s.app);
    await guest.me();
    expectError(await guest.request("POST", "/challenges/ch-s1-2/attempts", {}), 403, "FORBIDDEN");
    expectError(await a.request("POST", "/challenges/ch-s1-404/attempts", {}), 404, "NOT_FOUND");
    const b = await signedIn(s.app, "ranked_b");
    expectError(await b.request("GET", `/games/${game.game.id}`), 404, "NOT_FOUND");
  });

  it("the 500-move cap completes the attempt with the server-derived official score", async () => {
    const s = await server();
    const a = await signedIn(s.app, "ranked_cap");
    const started = (await a.request("POST", "/challenges/ch-s1-2/attempts", {})).json() as GameResponse;
    const full = s.app.services.games.stateAtInTransaction(s.db, started.game.id, 0);
    force(s, started.game.id, { ...full, acceptedMoves: 499 });
    const direction = legalMoves(full.board)[0] as Direction;
    const res = await a.request("POST", `/games/${started.game.id}/moves`, {
      commandId: cid(),
      expectedRevision: 0,
      direction,
    });
    const body = res.json() as MoveResponse;
    expect(body.state).toMatchObject({ acceptedMoves: 500, status: "completed" });
    expect(
      s.db.prepare("SELECT status, official_score, official_max_exponent FROM challenge_attempts").get(),
    ).toEqual({
      status: "completed",
      official_score: body.state.score,
      official_max_exponent: maxExponent(body.state.board),
    });
    expectError(await a.request("POST", "/challenges/ch-s1-2/attempts", {}), 403, "FORBIDDEN");
  });
});

describe("RANK-03 / DB-08 leaderboards", () => {
  async function finishedClassic(
    s: TestServer,
    c: TestClient,
    seed: string,
    score: string,
    cells = DEAD,
  ): Promise<string> {
    const g = (await c.request("POST", "/games", { mode: "classic", seed })).json() as GameResponse;
    force(s, g.game.id, {
      ...newGame(RULESETS["classic-v1"], seed),
      board: { size: 4, cells },
      score,
      status: "completed",
    });
    return g.game.id;
  }
  const board = async (c: TestClient, q: string) => {
    const res = await c.request("GET", `/leaderboards?${q}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Page<LeaderboardEntry>;
  };

  it("orders casual bests numerically with a stable total order and keyset pages", async () => {
    const s = await server();
    const users = [
      await signedIn(s.app, "lb_a"),
      await signedIn(s.app, "lb_b"),
      await signedIn(s.app, "lb_c"),
      await signedIn(s.app, "lb_d"),
    ];
    const two53 = (2n ** 53n).toString();
    const g1 = await finishedClassic(s, users[0] as TestClient, "a", two53);
    const g2 = await finishedClassic(s, users[1] as TestClient, "b", (2n ** 53n + 1n).toString());
    const g3 = await finishedClassic(s, users[2] as TestClient, "c", "10");
    const g4 = await finishedClassic(s, users[3] as TestClient, "d", "10");
    await finishedClassic(s, users[0] as TestClient, "a-worse", "9"); // only an account's best counts
    // excluded: practice, guests, bot games
    const practice = (
      await (users[1] as TestClient).request("POST", "/games", { mode: "practice", practice: { size: 4 } })
    ).json() as GameResponse;
    force(s, practice.game.id, { ...practice.state, score: "9".repeat(40) });
    const guest = new TestClient(s.app);
    await guest.me();
    await finishedClassic(s, guest, "guest", "8".repeat(40));

    const seen: LeaderboardEntry[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<LeaderboardEntry> = await board(
        users[0] as TestClient,
        `scope=casual&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.map((e) => e.gameId)).toEqual([g2, g1, g3, g4]);
    expect(seen.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(seen.every((e) => e.botStrategy === null && e.accountId !== null && e.rating === null)).toBe(true);
    expect(seen[0]).toMatchObject({
      displayName: "lb_b",
      score: (2n ** 53n + 1n).toString(),
      maxExponent: "2",
    });

    const mine = await board(users[3] as TestClient, `scope=casual&account=${userIdOf(s, "lb_d")}`);
    expect(mine.items.map((e) => [e.rank, e.gameId])).toEqual([[4, g4]]);
    expect((await board(users[0] as TestClient, "scope=casual&ruleset=bot-v1")).items).toEqual([]);
    expectError(
      await (users[0] as TestClient).request(
        "GET",
        `/leaderboards?scope=casual&limit=${LIMITS.listPageMax + 1}`,
      ),
      400,
      "VALIDATION_ERROR",
    );
    expectError(
      await (users[0] as TestClient).request("GET", "/leaderboards?scope=everything"),
      400,
      "VALIDATION_ERROR",
    );
    expectError(
      await (users[0] as TestClient).request("GET", "/leaderboards?scope=casual&cursor=junk"),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("challenge standings: completed official attempts only, exact order", async () => {
    const s = await server();
    const scores = ["123456789012345678901234567890", "99", "123456789012345678901234567891"];
    const ids: string[] = [];
    for (const [i, score] of scores.entries()) {
      const c = await signedIn(s.app, `ch_${i}`);
      const g = (await c.request("POST", "/challenges/ch-s1-1/attempts", {})).json() as GameResponse;
      const full = s.app.services.games.stateAtInTransaction(s.db, g.game.id, 0);
      force(s, g.game.id, { ...full, score, acceptedMoves: 499 });
      await c.request("POST", `/games/${g.game.id}/moves`, {
        commandId: cid(),
        expectedRevision: 0,
        direction: legalMoves(full.board)[0],
      });
      ids.push(g.game.id);
    }
    const forfeiter = await signedIn(s.app, "ch_ff");
    const ffGame = (
      await forfeiter.request("POST", "/challenges/ch-s1-1/attempts", {})
    ).json() as GameResponse;
    await forfeiter.request("POST", `/games/${ffGame.game.id}/forfeit`, {
      commandId: cid(),
      expectedRevision: 0,
    });
    const res = await board(forfeiter, "scope=challenge&challenge=ch-s1-1");
    expect(res.items.map((e) => e.gameId)).toEqual([ids[2], ids[0], ids[1]]);
    expect((await board(forfeiter, "scope=challenge")).items).toHaveLength(3);
    expect((await board(forfeiter, "scope=challenge&challenge=ch-s1-2")).items).toEqual([]);
  });

  it("duel-elo reads the ratings table; bot-league holds only bots", async () => {
    const s = await server();
    const viewer = await signedIn(s.app, "viewer");
    const now = new Date().toISOString();
    const ratings: [string, number][] = [
      ["r_one", 1012],
      ["r_two", 988],
      ["r_three", 1012],
    ];
    for (const [name, rating] of ratings) {
      await signedIn(s.app, name);
      s.db
        .prepare(
          "INSERT INTO ratings (user_id, season_id, ruleset_version, rating, played, won, drawn, lost, updated_at) VALUES (?, 'duel-s1', 'duel-v1', ?, 1, 1, 0, 0, ?)",
        )
        .run(userIdOf(s, name), rating, now);
    }
    const page1 = await board(viewer, "scope=duel-elo&limit=2");
    const page2 = await board(viewer, `scope=duel-elo&limit=2&cursor=${page1.nextCursor}`);
    const all = [...page1.items, ...page2.items];
    expect(all.map((e) => e.rating)).toEqual([1012, 1012, 988]);
    expect(all.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(all.every((e) => e.score === null && e.botStrategy === null)).toBe(true);

    // a finished bot-vs-bot match (as the matches service will write it)
    const matchId = randomUUID();
    s.db
      .prepare(
        "INSERT INTO matches (id, kind, season_id, ruleset_version, seed, status, outcome, created_at, updated_at, finalized_at) VALUES (?, 'bot-bot', 'duel-s1', 'duel-v1', 'm', 'finished', 'seat-a', ?, ?, ?)",
      )
      .run(matchId, now, now, now);
    for (const [seat, strategy, score] of [
      ["a", "greedy-v1", "200"],
      ["b", "random-v1", "100"],
    ] as const) {
      const game = await s.app.services.ctx.writer.run((tx) =>
        s.app.services.games.createInTransaction(tx, null, {
          mode: "bot-vs-bot",
          rules: RULESETS["duel-v1"],
          seed: "m",
        }),
      );
      force(s, game.id, { ...game.state, score });
      s.db
        .prepare(
          "INSERT INTO match_seats (match_id, seat, bot_strategy, bot_version, bot_config_json, game_id, joined_at) VALUES (?, ?, ?, 'v', ?, ?, ?)",
        )
        .run(matchId, seat, strategy, JSON.stringify({ nodeBudget: 100 }), game.id, now);
    }
    const league = await board(viewer, "scope=bot-league");
    expect(league.items.map((e) => [e.rank, e.botStrategy, e.score])).toEqual([
      [1, "greedy-v1", "200"],
      [2, "random-v1", "100"],
    ]);
    expect(league.items.every((e) => e.accountId === null)).toBe(true);
    for (const q of ["scope=casual", "scope=challenge", "scope=duel-elo"]) {
      expect(
        (await board(viewer, q)).items.some((e) => e.botStrategy !== null),
        q,
      ).toBe(false);
    }
  });
});

describe("REP-01..03 replays", () => {
  it("exports a verified replay (rules included, undone moves excluded) and round-trips an import", async () => {
    const s = await server();
    const c = await signedIn(s.app, "replayer", "Replay Fan");
    const g = (
      await c.request("POST", "/games", {
        mode: "practice",
        practice: { size: 5, fourWeight: 3, seed: "rp" },
      })
    ).json() as GameResponse;
    const last = await play(c, g.game.id, g.state.board, 0, 12);
    const undo = await c.request("POST", `/games/${g.game.id}/undo`, {
      commandId: cid(),
      expectedRevision: last.state.revision,
    });
    expect(undo.statusCode).toBe(200);
    const current = (undo.json() as GameResponse).state;

    const exp = await c.request("GET", `/replays/${g.game.id}`);
    expect(exp.statusCode, exp.body).toBe(200);
    const file = exp.json() as ReplayFile;
    const rules = practiceRuleset({ size: 5, fourWeight: 3, undo: true });
    expect(file.rules).toEqual(rules);
    expect(file.moves).toHaveLength(current.acceptedMoves);
    expect(file.moves.map((m) => m.revision)).toEqual(file.moves.map((_, i) => i + 1));
    expect(verifyReplay(file, rules)).toMatchObject({ ok: true });
    expect(file.meta).toEqual({
      mode: "practice",
      displayName: "Replay Fan",
      createdAt: g.game.createdAt,
      source: "local",
    });
    expect(exp.body).not.toMatch(/"(userId|accountId|username|password\w*|token\w*)"\s*:/);

    const imp = await c.request("POST", "/replays/import", file);
    expect(imp.statusCode, imp.body).toBe(201);
    const importId = (imp.json() as { id: string }).id;
    const again = (await c.request("GET", `/replays/${importId}`)).json() as ReplayFile;
    expect(again.moves).toEqual(file.moves);
    expect(again.meta.source).toBe("import");
    const other = await signedIn(s.app, "other");
    expectError(await other.request("GET", `/replays/${importId}`), 404, "NOT_FOUND");
    expectError(await other.request("GET", `/replays/${g.game.id}`), 404, "NOT_FOUND");
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 1 }); // import installs no game
  });

  it("rejects unsupported, tampered, corrupt, and oversize files without installing anything", async () => {
    const s = await server();
    const c = await signedIn(s.app, "rejector");
    const g = (await c.request("POST", "/games", { mode: "classic", seed: "rej" })).json() as GameResponse;
    await play(c, g.game.id, g.state.board, 0, 8);
    const file = (await c.request("GET", `/replays/${g.game.id}`)).json() as ReplayFile;
    const cases: [unknown, string][] = [
      [{ ...file, replaySchemaVersion: 2 }, "REPLAY_VERSION_UNSUPPORTED"],
      [{ ...file, engineVersion: "9.9.9" }, "REPLAY_VERSION_UNSUPPORTED"],
      [
        { ...file, moves: file.moves.map((m, i) => (i === 3 ? { ...m, checksum: "0".repeat(64) } : m)) },
        "IMPORT_INVALID",
      ],
      [{ ...file, initialState: { ...file.initialState, score: "999" } }, "IMPORT_INVALID"],
      [{ ...file, rules: { ...RULESETS["classic-v1"], moveCap: 10 } }, "IMPORT_INVALID"],
      [{ ...file, rulesetVersion: "mega-v9" }, "IMPORT_INVALID"],
      [{ ...file, moves: undefined }, "IMPORT_INVALID"],
    ];
    for (const [body, code] of cases)
      expectError(await c.request("POST", "/replays/import", body), 400, code);
    const corrupt = await s.app.inject({
      method: "POST",
      url: "/api/v1/replays/import",
      headers: {
        host: c.host,
        origin: c.origin as string,
        "x-csrf-token": c.csrf,
        cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "content-type": "application/json",
      },
      payload: '{"replaySchemaVersion":1,"moves":[',
    });
    expectError(corrupt, 400, "IMPORT_INVALID");
    const big = await c.request("POST", "/replays/import", {
      ...file,
      meta: { ...file.meta, displayName: "x".repeat(LIMITS.replayImportBytes) },
    });
    expectError(big, 400, "IMPORT_INVALID");
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM replay_imports").get()).toEqual({ n: 0 });
  });

  it("finished ranked games are public replays; active ones are hidden even from their owner", async () => {
    const s = await server();
    const a = await signedIn(s.app, "pub_a", "Public A");
    const g = (await a.request("POST", "/challenges/ch-s1-3/attempts", {})).json() as GameResponse;
    expectError(await a.request("GET", `/replays/${g.game.id}`), 404, "NOT_FOUND");
    await a.request("POST", `/games/${g.game.id}/forfeit`, { commandId: cid(), expectedRevision: 0 });
    const b = await signedIn(s.app, "pub_b");
    const res = await b.request("GET", `/replays/${g.game.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as ReplayFile).meta).toMatchObject({ mode: "ranked", displayName: "Public A" });
  });
});

describe("BOT-01/02 bot runs", () => {
  async function waitFor(c: TestClient, id: string): Promise<BotRunView> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const view = (await c.request("GET", `/bots/runs/${id}`)).json() as BotRunView;
      if (["finished", "cancelled", "failed"].includes(view.status)) return view;
      if (Date.now() > deadline) throw new Error(`run ${id} did not finish`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it(
    "runs deterministically in workers, records a bot-exhibition game, never touches human stats",
    { timeout: 120_000 },
    async () => {
      const s = await server();
      const c = await signedIn(s.app, "botfan");
      const body = {
        strategy: "greedy-v1",
        nodeBudget: 200,
        timeBudgetMs: 10_000,
        seed: "bot-seed",
        maxMoves: 12,
      };
      const created = await c.request("POST", "/bots/runs", body);
      expect(created.statusCode, created.body).toBe(201);
      const a = await waitFor(c, (created.json() as BotRunView).id);
      const b = await waitFor(c, ((await c.request("POST", "/bots/runs", body)).json() as BotRunView).id);
      expect(a).toMatchObject({
        status: "finished",
        strategy: "greedy-v1",
        movesPlayed: 12,
        nodeBudget: 200,
        seed: "bot-seed",
      });
      expect(a.lastDecision?.direction).toEqual(expect.any(String));
      const ga = (await c.request("GET", `/games/${a.gameId}`)).json() as GameResponse;
      const gb = (await c.request("GET", `/games/${b.gameId}`)).json() as GameResponse;
      expect(ga.game.mode).toBe("bot-exhibition");
      expect(checksum(gb.state)).toBe(checksum(ga.state));
      expect(s.app.services.games.verifyIntegrity(a.gameId as string).ok).toBe(true);
      expectError(
        await c.request("POST", `/games/${a.gameId}/moves`, {
          commandId: cid(),
          expectedRevision: 12,
          direction: "left",
        }),
        404,
        "NOT_FOUND",
      );
      expect(s.db.prepare("SELECT games_started, accepted_moves FROM profiles").get()).toEqual({
        games_started: 0,
        accepted_moves: 0,
      });
      expect(((await c.request("GET", "/games")).json() as Page<unknown>).items).toEqual([]);
      const row = s.db
        .prepare("SELECT status, bot_version, node_budget, game_id FROM bot_runs WHERE id = ?")
        .get(a.id);
      expect(row).toMatchObject({ status: "finished", node_budget: 200, game_id: a.gameId });
      const other = await signedIn(s.app, "notmine");
      expectError(await other.request("GET", `/bots/runs/${a.id}`), 404, "NOT_FOUND");
    },
  );

  it("step mode, pause/resume, idempotent cancel, and restart recovery", { timeout: 120_000 }, async () => {
    const s = await server();
    const c = await signedIn(s.app, "stepper");
    const created = (
      await c.request("POST", "/bots/runs", {
        strategy: "random-v1",
        nodeBudget: 10,
        timeBudgetMs: 1000,
        seed: "steps",
        maxMoves: 1000,
        stepMode: true,
      })
    ).json() as BotRunView;
    expect(created.status).toBe("paused");
    const stepped = (await c.request("POST", `/bots/runs/${created.id}/step`)).json() as BotRunView;
    expect(stepped.movesPlayed).toBe(1);
    const cancelled = (await c.request("POST", `/bots/runs/${created.id}/cancel`)).json() as BotRunView;
    expect(cancelled.status).toBe("cancelled");
    const again = await c.request("POST", `/bots/runs/${created.id}/cancel`);
    expect(again.statusCode).toBe(200);
    expect((again.json() as BotRunView).status).toBe("cancelled");

    // a run left "running" by a crashed process is cancelled at the next start, never a result
    const ghost = randomUUID();
    s.db
      .prepare(
        "INSERT INTO bot_runs (id, owner_user_id, strategy, bot_version, config_json, node_budget, time_budget_ms, seed, status, created_at, updated_at) VALUES (?, ?, 'greedy-v1', 'v', '{}', 10, 10, 's', 'running', ?, ?)",
      )
      .run(ghost, userIdOf(s, "stepper"), new Date().toISOString(), new Date().toISOString());
    const dir = s.dir;
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    const restarted = await server({ dir });
    const row = restarted.db
      .prepare(
        "SELECT status, json_extract(metrics_json, '$.interruptedByRestart') AS flag FROM bot_runs WHERE id = ?",
      )
      .get(ghost);
    expect(row).toEqual({ status: "cancelled", flag: 1 });
  });
});

describe("ENG-05 exactness through replays", () => {
  it("huge scores survive export", async () => {
    const s = await server();
    const c = await signedIn(s.app, "bigvalue");
    const g = (await c.request("POST", "/games", { mode: "classic", seed: "big" })).json() as GameResponse;
    const cells = Array<string | null>(16).fill(null);
    cells[0] = "4095";
    cells[1] = "4095";
    const seeded: GameState = { ...g.state, board: { size: 4, cells }, score: (1n << 60n).toString() };
    force(s, g.game.id, seeded);
    // replay export needs a consistent log: rewrite the revision-0 snapshot as a seed would
    s.db
      .prepare(
        "UPDATE game_snapshots SET state_json = ?, score = ?, checksum = ? WHERE game_id = ? AND revision = 0",
      )
      .run(JSON.stringify(seeded), seeded.score, checksum(seeded), g.game.id);
    const moved = (
      await c.request("POST", `/games/${g.game.id}/moves`, {
        commandId: cid(),
        expectedRevision: 0,
        direction: "left",
      })
    ).json() as MoveResponse;
    const file = (await c.request("GET", `/replays/${g.game.id}`)).json() as ReplayFile;
    expect(file.finalChecksum).toBe(checksum(moved.state));
    expect(moved.state.score).toBe(((1n << 60n) + (1n << 4096n)).toString());
    expect(applyMove(seeded, "left", RULESETS["classic-v1"]).state).toEqual(moved.state);
  });
});

describe("DB-08 cursors stay short for huge scores", () => {
  it("pages 300-digit scores with cursors well under the 256-character limit", async () => {
    const s = await server();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const c = await signedIn(s.app, `huge_${i}`);
      const g = (
        await c.request("POST", "/games", { mode: "classic", seed: `huge-${i}` })
      ).json() as GameResponse;
      force(s, g.game.id, {
        ...newGame(RULESETS["classic-v1"], `huge-${i}`),
        board: { size: 4, cells: DEAD },
        score: `${i + 1}${"0".repeat(299)}`,
        status: "completed",
      });
      ids.push(g.game.id);
    }
    const viewer = new TestClient(s.app);
    await viewer.me();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await viewer.request(
        "GET",
        `/leaderboards?scope=casual&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as Page<LeaderboardEntry>;
      seen.push(...page.items.map((e) => e.gameId as string));
      cursor = page.nextCursor;
      if (cursor) expect(cursor.length).toBeLessThan(120);
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
  });
});
