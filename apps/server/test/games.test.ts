import { describe, expect, it } from "vitest";
import { legalMoves, stateChecksum } from "@2048/engine";
import { LATEST_SCHEMA_VERSION } from "@2048/database";
import type { Direction, GameState, GameView, MoveResponse } from "@2048/contracts";
import { Client, cmd, startApp, stopApp, type ErrorBody, type TestEnv } from "./helpers.ts";

async function newUser(t: TestEnv, name = "player"): Promise<Client> {
  const c = new Client(t.app);
  expect((await c.register(name)).status).toBe(201);
  return c;
}

async function newGame(c: Client, body: Record<string, unknown> = { mode: "classic" }): Promise<GameView> {
  const r = await c.post("/games", body);
  expect(r.status).toBe(201);
  return r.body;
}

const move = (c: Client, g: { id: string }, expectedRevision: number, direction: Direction, commandId = cmd()) =>
  c.post<MoveResponse & ErrorBody>(`/games/${g.id}/moves`, { commandId, expectedRevision, direction });

/** Choose a direction that is guaranteed to change the board. */
const firstLegal = (s: GameState): Direction => legalMoves(s.board)[0]!;

async function play(c: Client, g: GameView, n: number): Promise<GameView> {
  let cur = g;
  for (let i = 0; i < n; i++) {
    const r = await move(c, cur, cur.state.revision, firstLegal(cur.state));
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    cur = r.body.game;
  }
  return cur;
}

describe("games: lifecycle", { timeout: 60_000 }, () => {
  it("creates a seeded classic game with the engine's initial state and lists/gets it", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    expect(g).toMatchObject({ mode: "classic", rulesetVersion: "classic-v1", undoAvailable: 0 });
    expect(g.state).toMatchObject({ revision: 0, acceptedMoves: 0, score: "0", status: "active", celebrated2048: false });
    expect(g.state.board.cells.filter((x) => x !== null)).toHaveLength(2);
    expect(g.seed).toMatch(/^[0-9a-f]{32}$/);
    const got = await c.get(`/games/${g.id}`);
    expect(got.body).toEqual(g);
    const list = await c.get("/games");
    expect(list.body.items.map((x: GameView) => x.id)).toEqual([g.id]);
    expect(list.body.nextCursor).toBeNull();
  });

  it("accepts a legal move: one authoritative spawn, revision+1, events and checksum chain", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    const dir = firstLegal(g.state);
    const r = await move(c, g, 0, dir);
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    expect(r.body.sequence).toBe(1);
    expect(r.body.game.state).toMatchObject({ revision: 1, acceptedMoves: 1 });
    expect(r.body.events.filter((e) => e.type === "spawn")).toHaveLength(1);
    expect(r.body.code).toBeUndefined();
    const ev = await c.get(`/games/${g.id}/events?cursor=0`);
    expect(ev.body.events).toHaveLength(1);
    expect(ev.body.events[0]).toMatchObject({ sequence: 1, direction: dir, checksum: stateChecksum(r.body.game.state) });
  });

  it("treats a no-op as 200 changed:false without touching revision, score, moves or RNG", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    // Deterministic board: tiles packed top-left, so "up" and "left" cannot change anything.
    const cells = Array<string | null>(16).fill(null);
    cells[0] = "1";
    cells[1] = "2";
    t.db.raw.prepare("UPDATE games SET cells_json = ?, max_exponent = '2' WHERE id = ?").run(JSON.stringify(cells), g.id);
    const dir: Direction = "up";
    const before = (await c.get(`/games/${g.id}`)).body as GameView;
    expect(before.state.board.cells).toEqual(cells);
    const r = await move(c, g, g.state.revision, dir);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: false, scoreDelta: "0", events: [], code: "NO_CHANGE", sequence: before.state.revision });
    const after = (await c.get(`/games/${g.id}`)).body as GameView;
    expect(after.state).toEqual(before.state);
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM game_moves WHERE game_id = ?").get(g.id)).toEqual({ n: before.state.revision });
    // the no-op is stored as a command, so a retry replays the same answer
    const id = cmd();
    const first = await move(c, g, g.state.revision, dir, id);
    const again = await move(c, g, g.state.revision, dir, id);
    expect(again.body).toEqual(first.body);
  });

  it("is idempotent per commandId and flags payload mismatches (DB-03)", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    const dir = firstLegal(g.state);
    const id = cmd();
    const a = await move(c, g, 0, dir, id);
    const b = await move(c, g, 0, dir, id);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const others = (["up", "right", "down", "left"] as const).filter((d) => d !== dir);
    const conflict = await move(c, g, 0, others[0]!, id);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const conflict2 = await move(c, g, 5, dir, id);
    expect(conflict2.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const now = (await c.get(`/games/${g.id}`)).body as GameView;
    expect(now.state.revision).toBe(1);
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM game_moves").get()).toEqual({ n: 1 });
  });

  it("accepts exactly one of two concurrent stale commands (DB-04)", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    const dir = firstLegal(g.state);
    const [x, y] = await Promise.all([move(c, g, 0, dir), move(c, g, 0, dir)]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.body.error).toMatchObject({ code: "REVISION_CONFLICT", details: { currentRevision: 1 } });
    expect((await c.get(`/games/${g.id}`)).body.state.revision).toBe(1);
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM game_moves").get()).toEqual({ n: 1 });
  });

  it("rolls the whole command back when persistence fails mid-transaction (DB-02)", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    // sabotage: a conflicting move row makes insertMove fail after the game row was already updated
    t.db.raw.prepare(
      "INSERT INTO game_moves (game_id, revision, command_id, kind, direction, accepted_moves, events_json, checksum, created_at) VALUES (?, 1, 'x', 'move', 'up', 1, '[]', ?, 't')",
    ).run(g.id, "a".repeat(64));
    const r = await move(c, g, 0, firstLegal(g.state));
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(r.body)).not.toMatch(/SQLITE|constraint|stack|at /i);
    const after = (await c.get(`/games/${g.id}`)).body as GameView;
    expect(after.state).toEqual(g.state);
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM game_commands").get()).toEqual({ n: 0 });
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM game_undo_stack").get()).toEqual({ n: 0 });
  });

  it("survives a server restart with identical state and keeps accepting moves", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await play(c, await newGame(c), 12);
    const login = c.cookies.get("sid")!;
    await stopApp(t);
    const t2 = await startApp({}, { dir: t.dir });
    const c2 = new Client(t2.app);
    c2.cookies.set("sid", login);
    const me = await c2.get("/auth/me");
    expect(me.status).toBe(200);
    c2.csrf = me.body.csrfToken;
    const back = await c2.get(`/games/${g.id}`);
    expect(back.body.state).toEqual(g.state);
    const r = await move(c2, g, g.state.revision, firstLegal(g.state));
    expect(r.status).toBe(200);
    expect(r.body.game.state.revision).toBe(13);
  });

  it("writes a snapshot every 50 accepted moves with a verifiable checksum", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await play(c, await newGame(c), 50);
    const snaps = t.db.raw.prepare("SELECT revision, state_checksum FROM game_snapshots WHERE game_id = ? ORDER BY revision").all(g.id);
    expect(snaps).toEqual([
      { revision: 0, state_checksum: expect.any(String) },
      { revision: 50, state_checksum: stateChecksum(g.state) },
    ]);
    // events endpoint pages through the full move log
    const seen: number[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: { body: { events: { sequence: number }[]; nextCursor: number | null } } = await c.get(`/games/${g.id}/events?cursor=${cursor}&limit=20`);
      seen.push(...page.body.events.map((e) => e.sequence));
      cursor = page.body.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  }, 120_000);

  it("keeps exponents 4096 and scores far beyond 2^53 exact through merge, JSON and SQLite (ENG-05)", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c, { mode: "practice", custom: { boardSize: 4, seed: "big" } });
    const cells = Array<string | null>(16).fill(null);
    cells[0] = "4096";
    cells[1] = "4096";
    cells[15] = "54";
    const hugeScore = "123456789012345678901234567890123456789";
    t.db.raw.prepare("UPDATE games SET cells_json = ?, score = ?, max_exponent = '4096' WHERE id = ?").run(JSON.stringify(cells), hugeScore, g.id);
    const r = await move(c, g, 0, "left");
    expect(r.status).toBe(200);
    expect(r.body.game.state.board.cells[0]).toBe("4097");
    expect(r.body.game.state.celebrated2048).toBe(false); // flag only flips when crossing 2048 in a move; board starts already high
    expect(r.body.scoreDelta).toBe((2n ** 4097n).toString());
    expect(r.body.game.state.score).toBe((BigInt(hugeScore) + 2n ** 4097n).toString());
    const back = (await c.get(`/games/${g.id}`)).body as GameView;
    expect(back.state.score).toBe(r.body.game.state.score);
    expect(back.state.board.cells).toEqual(r.body.game.state.board.cells);
    expect(t.db.raw.prepare("SELECT typeof(score) AS s, max_exponent FROM games WHERE id = ?").get(g.id)).toEqual({ s: "text", max_exponent: "4097" });
  });
});

describe("games: modes, rules and authorization", { timeout: 60_000 }, () => {
  it("supports custom sizes 3-8 with a deterministic seed and rejects invalid options", async () => {
    const t = await startApp();
    const c = await newUser(t);
    for (const size of [3, 5, 8]) {
      const g = await newGame(c, { mode: "practice", custom: { boardSize: size, seed: "fixed-seed" } });
      expect(g.state.board.size).toBe(size);
      expect(g.state.board.cells).toHaveLength(size * size);
      expect(g.rulesetVersion).toMatch(/^custom-v1:/);
      expect(g.seed).toBe("fixed-seed");
    }
    const a = await newGame(c, { mode: "practice", custom: { boardSize: 6, seed: "same" } });
    const b = await newGame(c, { mode: "practice", custom: { boardSize: 6, seed: "same" } });
    expect(a.state).toEqual(b.state);
    for (const custom of [{ boardSize: 2 }, { boardSize: 9 }, { boardSize: 4.5 }, { spawnFourTenths: 11 }, { seed: "" }, { moveCap: 5 }]) {
      const r = await c.post("/games", { mode: "practice", custom });
      expect(r.status, JSON.stringify(custom)).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION_ERROR");
    }
    // custom settings are not allowed for the official-style classic mode; ranked cannot be created here
    expect((await c.post("/games", { mode: "classic", custom: { boardSize: 5 } })).status).toBe(400);
    expect((await c.post("/games", { mode: "ranked" })).status).toBe(400);
    expect((await c.post("/games", { mode: "duel" })).status).toBe(400);
  });

  it("undo restores board, score, RNG and counters exactly while revision keeps increasing", async () => {
    const t = await startApp();
    const c = await newUser(t);
    let g = await newGame(c, { mode: "practice", custom: { seed: "undo-seed" } });
    const states: GameState[] = [g.state];
    for (let i = 0; i < 6; i++) {
      g = await play(c, g, 1);
      states.push(g.state);
    }
    expect(g.undoAvailable).toBe(6);
    const u1 = await c.post<MoveResponse & ErrorBody>(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: g.state.revision });
    expect(u1.status).toBe(200);
    const restored = u1.body.game.state;
    expect({ ...restored, revision: 0 }).toEqual({ ...states[5]!, revision: 0 });
    expect(restored.revision).toBe(7);
    expect(u1.body.game.undoAvailable).toBe(5);
    // replaying the same move after undo gives the same spawn (PRNG restored)
    const dir = firstLegal(restored);
    const re = await move(c, u1.body.game, restored.revision, dir);
    const again = await c.post<MoveResponse & ErrorBody>(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: re.body.game.state.revision });
    expect({ ...again.body.game.state, revision: 0 }).toEqual({ ...states[5]!, revision: 0 });
    // stale revision and idempotent retry
    const stale = await c.post(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: 0 });
    expect(stale.status).toBe(409);
    const id = cmd();
    const rev = again.body.game.state.revision;
    const x = await c.post<MoveResponse & ErrorBody>(`/games/${g.id}/undo`, { commandId: id, expectedRevision: rev });
    const y = await c.post<MoveResponse & ErrorBody>(`/games/${g.id}/undo`, { commandId: id, expectedRevision: rev });
    expect(y.body).toEqual(x.body);
    expect(x.body.game.undoAvailable).toBe(4);
  });

  it("refuses undo when there is nothing to undo, and records undo markers in the move log", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    expect((await c.post(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: 0 })).status).toBe(403);
    const g1 = await play(c, g, 1);
    await c.post(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: g1.state.revision });
    const kinds = t.db.raw.prepare("SELECT kind FROM game_moves WHERE game_id = ? ORDER BY revision").all(g.id);
    expect(kinds).toEqual([{ kind: "move" }, { kind: "undo" }]);
    // events API only exposes moves (direction required by the frozen contract)
    expect((await c.get(`/games/${g.id}/events`)).body.events).toHaveLength(1);
  });

  it("denies undo on official rulesets", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    // Promote the stored game to the official ranked ruleset to prove the server (not the client) enforces it.
    const ranked = { version: "ranked-v1", boardSize: 4, moveCap: 500, startTiles: 2, spawnFourTenths: 1, undoLimit: 0, official: true };
    t.db.raw.prepare("INSERT OR IGNORE INTO rulesets (version, rules_json, digest, created_at) VALUES ('ranked-v1', ?, ?, 't')").run(JSON.stringify(ranked), "b".repeat(64));
    t.db.raw.pragma("foreign_keys = OFF");
    t.db.raw.prepare("UPDATE games SET ruleset_version = 'ranked-v1' WHERE id = ?").run(g.id);
    t.db.raw.pragma("foreign_keys = ON");
    const r = await c.post(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: 0 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FORBIDDEN");
  });

  it("forfeits exactly once and then rejects further moves", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await play(c, await newGame(c), 3);
    const id = cmd();
    const f1 = await c.post<MoveResponse & ErrorBody>(`/games/${g.id}/forfeit`, { commandId: id, expectedRevision: g.state.revision });
    expect(f1.status).toBe(200);
    expect(f1.body.game.state.status).toBe("forfeited");
    const f2 = await c.post<MoveResponse & ErrorBody>(`/games/${g.id}/forfeit`, { commandId: id, expectedRevision: g.state.revision });
    expect(f2.body).toEqual(f1.body);
    const f3 = await c.post(`/games/${g.id}/forfeit`, { commandId: cmd(), expectedRevision: f1.body.sequence });
    expect(f3.status).toBe(403);
    const m = await move(c, f1.body.game, f1.body.sequence, "left");
    expect(m.status).toBe(403);
    expect((await c.post(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: f1.body.sequence })).status).toBe(403);
    expect((await c.get("/games")).body.items).toHaveLength(0); // only resumable (active) by default
    expect((await c.get("/games?status=forfeited")).body.items).toHaveLength(1);
    expect((await c.get("/games?status=all")).body.items).toHaveLength(1);
  });

  it("rejects moves on a completed game", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const g = await newGame(c);
    t.db.raw.prepare("UPDATE games SET status = 'completed' WHERE id = ?").run(g.id);
    const r = await move(c, g, 0, "left");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FORBIDDEN");
  });

  it("hides other users' games behind 404 for every endpoint", async () => {
    const t = await startApp();
    const a = await newUser(t, "alice");
    const b = await newUser(t, "bobby");
    const g = await newGame(a);
    const probes = [
      b.get(`/games/${g.id}`),
      b.get(`/games/${g.id}/events`),
      move(b, g, 0, "left"),
      b.post(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: 0 }),
      b.post(`/games/${g.id}/forfeit`, { commandId: cmd(), expectedRevision: 0 }),
    ];
    for (const r of await Promise.all(probes)) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("NOT_FOUND");
    }
    expect((await b.get("/games")).body.items).toEqual([]);
    expect((await new Client(t.app).get(`/games/${g.id}`)).status).toBe(401);
  });

  it("paginates the owner's games with a stable keyset cursor", async () => {
    const t = await startApp();
    const c = await newUser(t);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await newGame(c)).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { body: { items: GameView[]; nextCursor: string | null } } = await c.get(`/games?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.body.items.map((g) => g.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect((await c.get("/games?cursor=garbage")).status).toBe(400);
    expect((await c.get("/games?limit=1000")).status).toBe(400);
  });

  it("bounds active games per owner with RESOURCE_LIMIT", async () => {
    const t = await startApp({ MAX_ACTIVE_GAMES: "2" });
    const c = await newUser(t);
    await newGame(c);
    await newGame(c);
    const r = await c.post("/games", { mode: "classic" });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("RESOURCE_LIMIT");
  });
});

describe("api envelope and operations", { timeout: 60_000 }, () => {
  it("serves health and readiness, and uses the typed error envelope with request ids", async () => {
    const t = await startApp();
    const c = new Client(t.app);
    expect((await c.get("/health")).body).toEqual({ status: "ok" });
    const ready = await c.get("/ready");
    expect(ready.body).toMatchObject({ status: "ready", schemaVersion: LATEST_SCHEMA_VERSION, migrations: LATEST_SCHEMA_VERSION });
    const un = await c.get("/games");
    expect(un.status).toBe(401);
    expect(un.body.error).toMatchObject({ code: "UNAUTHENTICATED", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(un.headers["x-request-id"]).toBe(un.body.error.requestId);
    const nf = await c.get("/nope");
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("NOT_FOUND");
    expect((await t.app.inject({ method: "GET", url: "/health", headers: { host: "127.0.0.1:5511" } })).statusCode).toBe(200);
  });

  it("validates ids, bodies and sizes with VALIDATION_ERROR", async () => {
    const t = await startApp({ BODY_LIMIT_BYTES: "1024" });
    const c = await newUser(t);
    const g = await newGame(c);
    expect((await c.get("/games/not-a-uuid")).status).toBe(400);
    expect((await c.raw("POST", `/api/v1/games/${g.id}/moves`, "{not json")).status).toBe(400);
    expect((await c.post(`/games/${g.id}/moves`, { commandId: "short", expectedRevision: 0, direction: "up" })).status).toBe(400);
    expect((await c.post(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: -1, direction: "up" })).status).toBe(400);
    expect((await c.post(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: 0, direction: "diagonal" })).status).toBe(400);
    expect((await c.post(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: 1.5, direction: "up" })).status).toBe(400);
    expect((await c.post(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: 0, direction: "up", extra: 1 })).status).toBe(400);
    const big = await c.post(`/games/${g.id}/moves`, { commandId: "x".repeat(5000), expectedRevision: 0, direction: "up" });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("answers 429 with the envelope when the global request limit is exceeded", async () => {
    const t = await startApp({ REQUESTS_PER_MINUTE: "10" });
    const c = new Client(t.app);
    let last = 200;
    for (let i = 0; i < 15; i++) last = (await c.get("/health")).status;
    expect(last).toBe(429);
    const r = await c.get("/health");
    expect(r.body.error.code).toBe("RATE_LIMITED");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });
});
