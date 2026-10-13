import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  RULESETS,
  SNAPSHOT_INTERVAL,
  practiceRuleset,
  type Direction,
  type GameEventsResponse,
  type GameResponse,
  type GameState,
  type MoveResponse,
  type Ruleset,
} from "@g2048/contracts";
import { gamesRepo } from "@g2048/database";
import { applyMove, checksum, legalMoves, maxExponent, newGame } from "@g2048/engine";
import { removeDir, startTestServer, TestClient, type TestServer } from "./test-support.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
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

type ErrorBody = {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
};

function expectError(
  res: { statusCode: number; json: () => unknown; body: string },
  status: number,
  code: string,
) {
  expect(res.statusCode, res.body).toBe(status);
  const body = res.json() as ErrorBody;
  expect(body.error.code).toBe(code);
  return body;
}

let commandCounter = 0;
function cid(): string {
  commandCounter += 1;
  return `cmd-${String(commandCounter).padStart(8, "0")}`;
}

async function signedIn(app: TestServer["app"], username: string): Promise<TestClient> {
  const c = new TestClient(app);
  const res = await c.register(username);
  expect(res.statusCode, res.body).toBe(201);
  return c;
}

async function createGame(
  c: TestClient,
  body: unknown = { mode: "classic", seed: "seed-1" },
): Promise<GameResponse> {
  const res = await c.request("POST", "/games", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as GameResponse;
}

async function move(
  c: TestClient,
  id: string,
  direction: Direction,
  expectedRevision: number,
  commandId = cid(),
) {
  return c.request("POST", `/games/${id}/moves`, { commandId, expectedRevision, direction });
}

/** Plays `count` changing moves with a fixed preference order; returns the states after each move. */
async function play(c: TestClient, game: GameResponse, count: number): Promise<GameState[]> {
  let state = game.state;
  const states: GameState[] = [];
  for (let i = 0; i < count; i += 1) {
    const legal = legalMoves(state.board);
    const direction = (["down", "left", "right", "up"] as const).find((d) => legal.includes(d));
    if (!direction) throw new Error(`no legal move after ${i} moves`);
    const res = await move(c, game.game.id, direction, state.revision);
    expect(res.statusCode, res.body).toBe(200);
    state = (res.json() as MoveResponse).state;
    states.push(state);
  }
  return states;
}

const count = (db: DatabaseSync, sql: string, ...params: (string | number)[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

describe("SOLO-01/02 create, list, read", () => {
  it("creates a classic game whose initial state is the engine's for that seed", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    const created = await createGame(alice, { mode: "classic", seed: "fixed-seed" });
    expect(created.state).toEqual(newGame(RULESETS["classic-v1"], "fixed-seed"));
    expect(created.game).toMatchObject({
      mode: "classic",
      rulesetVersion: "classic-v1",
      revision: 0,
      status: "active",
    });
    expect(created.canUndo).toBe(false);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM game_snapshots WHERE game_id = ? AND revision = 0",
        created.game.id,
      ),
    ).toBe(1);
    expect(count(db, "SELECT games_started AS n FROM profiles")).toBe(1);

    const got = await alice.request("GET", `/games/${created.game.id}`);
    expect(got.json()).toEqual(created);
    const list = (await alice.request("GET", "/games")).json() as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(list.items.map((g) => g.id)).toEqual([created.game.id]);

    const random = await createGame(alice, { mode: "classic" }); // server-chosen seed
    expect(random.state.board.cells.filter((c) => c !== null)).toHaveLength(2);
  });

  it("creates practice games 3x3..8x8 with custom rules; rejects other sizes and client-supplied state", async () => {
    const { app } = await server();
    const alice = await signedIn(app, "alice");
    for (const size of [3, 8]) {
      const g = await createGame(alice, {
        mode: "practice",
        practice: { size, fourWeight: 10, seed: "p", undo: true },
      });
      expect(g.state.board.size).toBe(size);
      expect(g.game.rulesetVersion).toBe("practice-v1");
      expect(g.state).toEqual(newGame(practiceRuleset({ size, fourWeight: 10, undo: true }), "p"));
      expect(g.state.board.cells.filter((c) => c !== null).every((c) => c === "2")).toBe(true); // fourWeight 10
    }
    for (const size of [2, 9]) {
      expectError(
        await alice.request("POST", "/games", { mode: "practice", practice: { size } }),
        400,
        "VALIDATION_ERROR",
      );
    }
    expectError(await alice.request("POST", "/games", { mode: "ranked" }), 400, "VALIDATION_ERROR");
    expectError(
      await alice.request("POST", "/games", { mode: "classic", seed: "x".repeat(129) }),
      400,
      "VALIDATION_ERROR",
    );
    const forged = await alice.request("POST", "/games", { mode: "classic", score: "999999" });
    expect((forged.json() as GameResponse).state.score).toBe("0"); // extra keys are ignored, never trusted
  });

  it("paginates resumable games with a stable cursor", async () => {
    const { app } = await server();
    const alice = await signedIn(app, "alice");
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1)
      ids.push((await createGame(alice, { mode: "classic", seed: `s${i}` })).game.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const page = (await alice.request("GET", `/games${query}`)).json() as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((g) => g.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
    expectError(await alice.request("GET", "/games?cursor=not-a-cursor"), 400, "VALIDATION_ERROR");
  });
});

describe("authoritative moves", () => {
  it("applies the engine transition server-side and persists command, move, and state atomically", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    const game = await createGame(alice);
    const direction = legalMoves(game.state.board)[0] as Direction;
    const res = await move(alice, game.game.id, direction, 0);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as MoveResponse;
    const expected = applyMove(game.state, direction, RULESETS["classic-v1"]);
    expect(body.changed).toBe(true);
    expect(body.state).toEqual(expected.state);
    expect(body.scoreDelta).toBe(expected.scoreDelta);
    expect(body.events.some((e) => e.type === "tile.spawned")).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM game_moves WHERE game_id = ?", game.game.id)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM game_commands WHERE game_id = ?", game.game.id)).toBe(1);
    const row = db
      .prepare("SELECT revision, score, state_checksum FROM games WHERE id = ?")
      .get(game.game.id);
    expect(row).toEqual({
      revision: 1,
      score: expected.state.score,
      state_checksum: checksum(expected.state),
    });
    expect(count(db, "SELECT accepted_moves AS n FROM profiles")).toBe(1);
  });

  it("records a no-op in game_commands only: 200 changed:false NO_CHANGE, no revision/PRNG change", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    let game: GameResponse | null = null;
    let noop: Direction | undefined;
    for (let i = 0; i < 50 && !noop; i += 1) {
      game = await createGame(alice, { mode: "classic", seed: `noop-${i}` });
      const legal = legalMoves(game.state.board);
      noop = (["up", "right", "down", "left"] as const).find((d) => !legal.includes(d));
    }
    if (!game || !noop) throw new Error("no seed with a no-op direction found");
    const res = await move(alice, game.game.id, noop, 0);
    expect(res.statusCode).toBe(200);
    const body = res.json() as MoveResponse;
    expect(body).toMatchObject({ changed: false, scoreDelta: "0", events: [], code: "NO_CHANGE" });
    expect(body.state).toEqual(game.state);
    expect(count(db, "SELECT COUNT(*) AS n FROM game_moves WHERE game_id = ?", game.game.id)).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM game_commands WHERE game_id = ? AND outcome = 'no-change'",
        game.game.id,
      ),
    ).toBe(1);
    const after = (await alice.request("GET", `/games/${game.game.id}`)).json() as GameResponse;
    expect(after.state.revision).toBe(0);
    expect(after.state.rng).toEqual(game.state.rng);
    expect(count(db, "SELECT accepted_moves AS n FROM profiles")).toBe(0);
  });

  it("DB-03 a repeated commandId returns the identical stored result; a different payload conflicts", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    const game = await createGame(alice);
    const [first, second] = legalMoves(game.state.board) as Direction[];
    const commandId = "retry-me-0001";
    const a = await move(alice, game.game.id, first as Direction, 0, commandId);
    const b = await move(alice, game.game.id, first as Direction, 0, commandId);
    expect(b.statusCode).toBe(200);
    expect(b.body).toBe(a.body);
    expect(count(db, "SELECT COUNT(*) AS n FROM game_moves WHERE game_id = ?", game.game.id)).toBe(1);
    if (second) {
      expectError(await move(alice, game.game.id, second, 0, commandId), 409, "IDEMPOTENCY_CONFLICT");
    }
    expectError(
      await move(alice, game.game.id, first as Direction, 1, commandId),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    await play(alice, (await alice.request("GET", `/games/${game.game.id}`)).json() as GameResponse, 2);
    const late = await move(alice, game.game.id, first as Direction, 0, commandId);
    expect(late.body).toBe(a.body); // stored response wins even after the game moved on
  });

  it("DB-04 two stale clients: exactly one move is accepted, one spawn, the other gets REVISION_CONFLICT", async () => {
    const { app, db } = await server();
    const tab1 = await signedIn(app, "alice");
    const tab2 = new TestClient(app);
    expect((await tab2.login("alice", "correct horse battery")).statusCode).toBe(200);
    const game = await createGame(tab1);
    const legal = legalMoves(game.state.board) as Direction[];
    const [r1, r2] = await Promise.all([
      move(tab1, game.game.id, legal[0] as Direction, 0),
      move(tab2, game.game.id, (legal[1] ?? legal[0]) as Direction, 0),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(expectError(loser, 409, "REVISION_CONFLICT").error.details).toEqual({ currentRevision: 1 });
    const winner = (r1.statusCode === 200 ? r1 : r2).json() as MoveResponse;
    expect(count(db, "SELECT COUNT(*) AS n FROM game_moves WHERE game_id = ?", game.game.id)).toBe(1);
    const now = (await tab1.request("GET", `/games/${game.game.id}`)).json() as GameResponse;
    expect(now.state).toEqual(winner.state);
    expect(now.state.board.cells.filter((c) => c !== null).length).toBeLessThanOrEqual(
      game.state.board.cells.filter((c) => c !== null).length + 1,
    );
  });

  it("only the owner can read or command a game; others get 404", async () => {
    const { app } = await server();
    const alice = await signedIn(app, "alice");
    const bob = await signedIn(app, "bob");
    const game = await createGame(alice);
    const id = game.game.id;
    expectError(await bob.request("GET", `/games/${id}`), 404, "NOT_FOUND");
    expectError(await move(bob, id, "left", 0), 404, "NOT_FOUND");
    expectError(
      await bob.request("POST", `/games/${id}/undo`, { commandId: cid(), expectedRevision: 0 }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await bob.request("POST", `/games/${id}/forfeit`, { commandId: cid(), expectedRevision: 0 }),
      404,
      "NOT_FOUND",
    );
    expectError(await bob.request("GET", `/games/${id}/events`), 404, "NOT_FOUND");
    expect(((await bob.request("GET", "/games")).json() as { items: unknown[] }).items).toEqual([]);
    const anon = new TestClient(app);
    await anon.me();
    expectError(await anon.request("GET", `/games/${id}`), 404, "NOT_FOUND");
    expect((await anon.request("GET", "/games")).json()).toEqual({ items: [], nextCursor: null });
    expectError(await alice.request("GET", "/games/not-a-uuid"), 404, "NOT_FOUND");
    expect((await alice.request("GET", `/games/${id}`)).statusCode).toBe(200);
  });

  it("guests play casual games under their own lazily created identity", async () => {
    const { app } = await server();
    const guest = new TestClient(app);
    await guest.me();
    const csrf = guest.csrf;
    const game = await createGame(guest);
    expect(guest.csrf).toBe(csrf); // pending token adopted: CSRF stays valid
    expect(
      (await move(guest, game.game.id, legalMoves(game.state.board)[0] as Direction, 0)).statusCode,
    ).toBe(200);
    const me = (await guest.me()) as { guest: { id: string } | null };
    expect(me.guest?.id).toEqual(expect.any(String));
    const alice = await signedIn(app, "alice");
    expectError(await alice.request("GET", `/games/${game.game.id}`), 404, "NOT_FOUND");
  });
});

describe("SOLO-03 undo, forfeit, events", () => {
  it("undo restores the complete prior state including PRNG and score; replays stay coherent", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    const game = await createGame(alice, { mode: "classic", seed: "undo-seed" });
    const states = await play(alice, game, 3);
    const s1 = states[0] as GameState;
    const s2 = states[1] as GameState;

    const u1 = await alice.request("POST", `/games/${game.game.id}/undo`, {
      commandId: cid(),
      expectedRevision: 3,
    });
    expect(u1.statusCode, u1.body).toBe(200);
    const after1 = (u1.json() as GameResponse).state;
    expect(after1).toEqual({ ...s2, revision: 4 });
    expect(after1.rng).toEqual(s2.rng);
    const u2 = await alice.request("POST", `/games/${game.game.id}/undo`, {
      commandId: cid(),
      expectedRevision: 4,
    });
    const after2 = (u2.json() as GameResponse).state;
    expect(after2).toEqual({ ...s1, revision: 5 });
    expect((u2.json() as GameResponse).canUndo).toBe(true);
    expect(
      db
        .prepare("SELECT revision, kind, undone FROM game_moves WHERE game_id = ? ORDER BY revision")
        .all(game.game.id),
    ).toEqual([
      { revision: 1, kind: "move", undone: 0 },
      { revision: 2, kind: "move", undone: 1 },
      { revision: 3, kind: "move", undone: 1 },
      { revision: 4, kind: "undo", undone: 0 },
      { revision: 5, kind: "undo", undone: 0 },
    ]);

    // The next move uses the restored PRNG: identical to playing it right after move 1.
    const direction = legalMoves(s1.board)[0] as Direction;
    const next = (await move(alice, game.game.id, direction, 5)).json() as MoveResponse;
    const expected = applyMove(s1, direction, RULESETS["classic-v1"]).state;
    expect(next.state).toEqual({ ...expected, revision: 6 });
    expect(app.services.games.verifyIntegrity(game.game.id)).toMatchObject({ ok: true, revision: 6 });

    const events = (
      await alice.request("GET", `/games/${game.game.id}/events?afterRevision=3&limit=2`)
    ).json() as GameEventsResponse;
    expect(events.events.map((e) => [e.revision, e.kind])).toEqual([
      [4, "undo"],
      [5, "undo"],
    ]);
    expect(events).toMatchObject({ nextAfterRevision: 5, done: false });
    const rest = (
      await alice.request("GET", `/games/${game.game.id}/events?afterRevision=5`)
    ).json() as GameEventsResponse;
    expect(rest).toMatchObject({ nextAfterRevision: 6, done: true });
    expect(rest.events[0]?.direction).toBe(direction);
  });

  it("undo is limited to the history cap and refused in ranked or undo-less modes", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    const game = await createGame(alice, {
      mode: "practice",
      practice: { size: 8, seed: "long", undo: true },
    });
    await play(alice, game, 101);
    let revision = 101;
    for (let i = 0; i < 100; i += 1) {
      const res = await alice.request("POST", `/games/${game.game.id}/undo`, {
        commandId: cid(),
        expectedRevision: revision,
      });
      expect(res.statusCode, res.body).toBe(200);
      revision += 1;
    }
    const capped = await alice.request("POST", `/games/${game.game.id}/undo`, {
      commandId: cid(),
      expectedRevision: revision,
    });
    expectError(capped, 400, "VALIDATION_ERROR"); // CONTRACT-001 C11
    expect(((await alice.request("GET", `/games/${game.game.id}`)).json() as GameResponse).canUndo).toBe(
      false,
    );
    // TOTAL depth is capped (SEC-R2-07): one new move re-enables exactly one undo, not 99 more.
    const current = ((await alice.request("GET", `/games/${game.game.id}`)).json() as GameResponse).state;
    const moved = (
      await move(alice, game.game.id, legalMoves(current.board)[0] as Direction, revision)
    ).json() as MoveResponse;
    revision = moved.state.revision;
    const once = await alice.request("POST", `/games/${game.game.id}/undo`, {
      commandId: cid(),
      expectedRevision: revision,
    });
    expect(once.statusCode, once.body).toBe(200);
    revision += 1;
    expectError(
      await alice.request("POST", `/games/${game.game.id}/undo`, {
        commandId: cid(),
        expectedRevision: revision,
      }),
      400,
      "VALIDATION_ERROR",
    );
    expect(app.services.games.verifyIntegrity(game.game.id).ok).toBe(true);

    const noUndo = await createGame(alice, {
      mode: "practice",
      practice: { size: 4, seed: "nu", undo: false },
    });
    await play(alice, noUndo, 1);
    expectError(
      await alice.request("POST", `/games/${noUndo.game.id}/undo`, { commandId: cid(), expectedRevision: 1 }),
      403,
      "FORBIDDEN",
    );

    const userId = (
      db.prepare("SELECT id FROM users WHERE username_normalized = 'alice'").get() as { id: string }
    ).id;
    const ranked = await app.services.ctx.writer.run((tx) =>
      app.services.games.createInTransaction(
        tx,
        { userId },
        { mode: "ranked", rules: RULESETS["ranked-v1"], seed: "r" },
      ),
    );
    const rankedGame = (await alice.request("GET", `/games/${ranked.id}`)).json() as GameResponse;
    await play(alice, rankedGame, 1);
    expectError(
      await alice.request("POST", `/games/${ranked.id}/undo`, { commandId: cid(), expectedRevision: 1 }),
      403,
      "FORBIDDEN",
    );
  });

  it("forfeit ends a game exactly once", async () => {
    const { app } = await server();
    const alice = await signedIn(app, "alice");
    const game = await createGame(alice);
    const commandId = cid();
    const first = await alice.request("POST", `/games/${game.game.id}/forfeit`, {
      commandId,
      expectedRevision: 0,
    });
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json() as GameResponse;
    expect(body.state).toMatchObject({ status: "forfeited", revision: 1, score: "0" });
    expect(body.state.board).toEqual(game.state.board);
    expect(body.canUndo).toBe(false);
    const again = await alice.request("POST", `/games/${game.game.id}/forfeit`, {
      commandId,
      expectedRevision: 0,
    });
    expect(again.body).toBe(first.body);
    expectError(
      await alice.request("POST", `/games/${game.game.id}/forfeit`, {
        commandId: cid(),
        expectedRevision: 1,
      }),
      403,
      "FORBIDDEN",
    );
    expectError(await move(alice, game.game.id, "left", 1), 403, "FORBIDDEN");
    expectError(
      await alice.request("POST", `/games/${game.game.id}/undo`, { commandId: cid(), expectedRevision: 1 }),
      403,
      "FORBIDDEN",
    );
    expect(((await alice.request("GET", "/games")).json() as { items: unknown[] }).items).toEqual([]);
  });
});

describe("snapshots, replay verification, exact values", () => {
  it("snapshots every SNAPSHOT_INTERVAL revisions and verifies by replaying from the nearest one", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    const game = await createGame(alice, {
      mode: "practice",
      practice: { size: 8, seed: "snap", undo: true },
    });
    await play(alice, game, 2 * SNAPSHOT_INTERVAL + 7);
    const snaps = db
      .prepare("SELECT revision FROM game_snapshots WHERE game_id = ? ORDER BY revision")
      .all(game.game.id);
    expect(snaps).toEqual([
      { revision: 0 },
      { revision: SNAPSHOT_INTERVAL },
      { revision: 2 * SNAPSHOT_INTERVAL },
    ]);
    expect(app.services.games.verifyIntegrity(game.game.id)).toEqual({
      gameId: game.game.id,
      ok: true,
      revision: 2 * SNAPSHOT_INTERVAL + 7,
      snapshotRevision: 2 * SNAPSHOT_INTERVAL,
      replayedMoves: 7,
    });
    expect(app.services.games.verifyActiveGames().every((r) => r.ok)).toBe(true);

    db.prepare("UPDATE game_moves SET checksum = ? WHERE game_id = ? AND revision = ?").run(
      "0".repeat(64),
      game.game.id,
      2 * SNAPSHOT_INTERVAL + 3,
    );
    const broken = app.services.games.verifyIntegrity(game.game.id);
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/does not replay/);

    db.prepare("UPDATE games SET score = '123456789' WHERE id = ?").run(game.game.id);
    const tampered = await alice.request("GET", `/games/${game.game.id}`);
    expectError(tampered, 500, "INTERNAL_ERROR");
    expect(tampered.body).not.toContain("checksum");
  });

  it("ENG-05 keeps exponents >= 4096 and scores > 2^53 exact through SQLite and JSON", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    const game = await createGame(alice, { mode: "classic", seed: "huge" });
    const cells = Array.from({ length: 16 }, () => null as string | null);
    cells[0] = "4096";
    cells[1] = "4096";
    cells[5] = "54";
    const big = (2n ** 53n + 1n).toString();
    const forced: GameState = { ...game.state, board: { size: 4, cells }, score: big };
    gamesRepo.updateState(
      db,
      game.game.id,
      0,
      forced,
      checksum(forced),
      maxExponent(forced.board),
      new Date().toISOString(),
    );

    const res = await move(alice, game.game.id, "left", 0);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as MoveResponse;
    const merged = 2n ** 4097n;
    expect(body.scoreDelta).toBe(merged.toString());
    expect(body.state.score).toBe((2n ** 53n + 1n + merged).toString());
    expect(body.state.board.cells[0]).toBe("4097");
    const row = db
      .prepare("SELECT typeof(score) AS t, score, max_exponent FROM games WHERE id = ?")
      .get(game.game.id);
    expect(row).toEqual({ t: "text", score: body.state.score, max_exponent: "4097" });
    expect(((await alice.request("GET", `/games/${game.game.id}`)).json() as GameResponse).state.score).toBe(
      body.state.score,
    );
    expect(db.prepare("SELECT best_score, max_exponent FROM profiles").get()).toEqual({
      best_score: body.state.score,
      max_exponent: "4097",
    });
  });

  it("RESOURCE_LIMIT preserves the last valid state (503, nothing recorded)", async () => {
    const { app, db } = await server();
    const alice = await signedIn(app, "alice");
    const game = await createGame(alice, { mode: "classic", seed: "limit" });
    const cells = Array.from({ length: 16 }, () => null as string | null);
    cells[0] = "1000000";
    cells[1] = "1000000";
    const forced: GameState = { ...game.state, board: { size: 4, cells } };
    gamesRepo.updateState(db, game.game.id, 0, forced, checksum(forced), "1000000", new Date().toISOString());
    expectError(await move(alice, game.game.id, "left", 0), 503, "RESOURCE_LIMIT");
    const after = (await alice.request("GET", `/games/${game.game.id}`)).json() as GameResponse;
    expect(after.state).toEqual(forced);
    expect(count(db, "SELECT COUNT(*) AS n FROM game_commands WHERE game_id = ?", game.game.id)).toBe(0);
  });
});

describe("DB-02 process termination during a move", () => {
  function runChild(
    dbPath: string,
    gameId: string,
    userId: string,
    commandId: string,
    rev: number,
    dir: string,
    stage: string,
  ) {
    return spawnSync(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        join(here, "test-fixtures", "kill-mid-move.ts"),
        dbPath,
        gameId,
        userId,
        commandId,
        String(rev),
        dir,
        stage,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
    );
  }

  it("recovers either the entire previous or the entire next state, never a partial move", async () => {
    const s = await server();
    const alice = await signedIn(s.app, "alice");
    const game = await createGame(alice, { mode: "classic", seed: "crash" });
    const userId = (s.db.prepare("SELECT id FROM users").get() as { id: string }).id;
    const rules: Ruleset = RULESETS["classic-v1"];
    const direction = legalMoves(game.state.board)[0] as Direction;

    const killed = runChild(
      s.dbPath,
      game.game.id,
      userId,
      "crash-cmd-0001",
      0,
      direction,
      "mid-transaction",
    );
    expect(killed.status, killed.stderr).toBe(137);
    let db = new DatabaseSync(s.dbPath);
    expect(db.prepare("SELECT revision, state_checksum FROM games WHERE id = ?").get(game.game.id)).toEqual({
      revision: 0,
      state_checksum: checksum(game.state),
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM game_moves")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM game_commands")).toBe(0);
    db.close();

    const committed = runChild(
      s.dbPath,
      game.game.id,
      userId,
      "crash-cmd-0002",
      0,
      direction,
      "after-commit",
    );
    expect(committed.status, committed.stderr).toBe(137);
    db = new DatabaseSync(s.dbPath);
    const expected = applyMove(game.state, direction, rules).state;
    expect(db.prepare("SELECT revision, state_checksum FROM games WHERE id = ?").get(game.game.id)).toEqual({
      revision: 1,
      state_checksum: checksum(expected),
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM game_moves")).toBe(1);
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe(
      "ok",
    );
    db.close();

    expect(s.app.services.games.verifyIntegrity(game.game.id)).toMatchObject({ ok: true, revision: 1 });
    const resumed = (await alice.request("GET", `/games/${game.game.id}`)).json() as GameResponse;
    expect(resumed.state).toEqual(expected);
    // The retried command id from the killed attempt was never recorded, so it is simply applied now.
    expect(
      (await move(alice, game.game.id, legalMoves(expected.board)[0] as Direction, 1, "crash-cmd-0001"))
        .statusCode,
    ).toBe(200);
  }, 120_000);
});
