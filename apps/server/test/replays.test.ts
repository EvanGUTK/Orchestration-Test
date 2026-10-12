import { describe, expect, it } from "vitest";
import { legalMoves, newGame, replay, stateChecksum } from "@2048/engine";
import { resolveRules, type GameView, type MoveResponse, type Page, type ReplayView, type ReplaySummary, type LeaderboardEntry } from "@2048/contracts";
import { Client, cmd, startApp, type ErrorBody, type TestEnv } from "./helpers.ts";

async function user(t: TestEnv, name: string): Promise<Client> {
  const c = new Client(t.app);
  expect((await c.register(name)).status).toBe(201);
  return c;
}

async function play(c: Client, g: GameView, n: number): Promise<GameView> {
  let cur = g;
  for (let i = 0; i < n; i++) {
    const r = await c.post<MoveResponse>(`/games/${cur.id}/moves`, { commandId: cmd(), expectedRevision: cur.state.revision, direction: legalMoves(cur.state.board)[0] });
    expect(r.status).toBe(200);
    cur = r.body.game;
  }
  return cur;
}

/** Independently verify a ReplayView against the pure engine. */
function verify(view: ReplayView): void {
  const rules = resolveRules(view.rulesetVersion)!;
  const initial = newGame(rules, view.seed);
  const out = replay(initial, view.moves.map((m) => m.direction), rules);
  expect(out.steps.map((s) => s.checksum)).toEqual(view.moves.map((m) => m.checksum));
  expect(out.steps.every((s) => s.changed)).toBe(true);
  expect(view.finalChecksum).toBe(view.moves.length ? out.steps[out.steps.length - 1]!.checksum : stateChecksum(initial));
  expect(view.finalScore).toBe(out.state.score);
  view.moves.forEach((m, i) => expect(m.sequence).toBe(i + 1));
  for (const s of view.snapshots) {
    const expected = s.sequence === 0 ? stateChecksum(initial) : view.moves[s.sequence - 1]!.checksum;
    expect(s.checksum).toBe(expected);
    expect(stateChecksum(s.state)).toBe(expected);
  }
}

describe("replays", { timeout: 120_000 }, () => {
  it("reproduces every checksum and the final state, with snapshots every 50 moves (REP-01)", async () => {
    const t = await startApp();
    const c = await user(t, "replayer");
    let g = (await c.post<GameView>("/games", { mode: "classic" })).body;
    g = await play(c, g, 53);
    const r = await c.get<ReplayView>(`/replays/${g.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schemaVersion: 1, engineVersion: "engine-1.0.0", rulesetVersion: "classic-v1", seed: g.seed, undoMarkers: [] });
    expect(r.body.moves).toHaveLength(53);
    expect(r.body.snapshots.map((s) => s.sequence)).toEqual([0, 50]);
    expect(r.body.finalScore).toBe(g.state.score);
    verify(r.body);
    expect((await new Client(t.app).get(`/replays/${g.id}`)).status).toBe(401);
    expect((await (await user(t, "snoop")).get(`/replays/${g.id}`)).status).toBe(404);
  });

  it("keeps an undone move out of the final path and records undo markers", async () => {
    const t = await startApp();
    const c = await user(t, "undoer");
    let g = (await c.post<GameView>("/games", { mode: "practice", custom: { seed: "undo-replay", boardSize: 5 } })).body;
    g = await play(c, g, 12);
    for (let i = 0; i < 3; i++) {
      const u = await c.post<MoveResponse>(`/games/${g.id}/undo`, { commandId: cmd(), expectedRevision: g.state.revision });
      expect(u.status).toBe(200);
      g = u.body.game;
    }
    g = await play(c, g, 9);
    const r = (await c.get<ReplayView>(`/replays/${g.id}`)).body;
    expect(r.moves).toHaveLength(18); // 12 - 3 + 9
    expect(r.undoMarkers).toEqual([{ atSequence: 12, branch: 1 }, { atSequence: 11, branch: 2 }, { atSequence: 10, branch: 3 }]);
    verify(r);
    expect(r.finalScore).toBe(g.state.score);
  });

  it("hides ranked replays (and the seed) until the attempt ends", async () => {
    const t = await startApp({}, undefined, { now: () => new Date("2026-10-15T12:00:00Z") });
    const c = await user(t, "ranked_replay");
    const ch = (await c.get<Page<{ id: string }>>("/challenges")).body.items[0]!;
    const g = (await c.post<GameView>(`/challenges/${ch.id}/attempts`)).body;
    const early = await c.get<ErrorBody>(`/replays/${g.id}`);
    expect(early.status).toBe(403);
    await c.post(`/games/${g.id}/forfeit`, { commandId: cmd(), expectedRevision: 0 });
    const after = await c.get<ReplayView>(`/replays/${g.id}`);
    expect(after.status).toBe(200);
    expect(after.body.seed).toMatch(/^[0-9a-f]{32}$/);
    verify(after.body);
    const list = await c.get<Page<ReplaySummary>>("/replays");
    expect(list.body.items.map((x) => x.gameId)).toEqual([g.id]);
    expect(list.body.items[0]).toMatchObject({ mode: "ranked", rulesetVersion: "ranked-v1", finalScore: "0" });
  });

  it("exports and imports a replay with exact values, never ranked, never leaking identity (REP-02)", async () => {
    const t = await startApp();
    const a = await user(t, "exporter_a");
    const b = await user(t, "importer_b");
    let g = (await a.post<GameView>("/games", { mode: "classic" })).body;
    g = await play(a, g, 20);
    const exported = (await a.get<ReplayView>(`/replays/${g.id}`)).body;
    expect(JSON.stringify(exported)).not.toMatch(/exporter_a|userId|csrf|token|password/i);

    const imp = await b.post<ReplaySummary>("/replays/import", exported);
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ mode: "practice", rulesetVersion: "classic-v1", finalScore: exported.finalScore, acceptedMoves: 20 });
    const got = await b.get<ReplayView>(`/replays/${imp.body.gameId}`);
    expect(got.body).toEqual(exported);
    expect((await a.get(`/replays/${imp.body.gameId}`)).status).toBe(404); // private to the importer
    expect((await b.get<Page<ReplaySummary>>("/replays")).body.items.map((x) => x.gameId)).toEqual([imp.body.gameId]);
    // imports are not games and never reach any board
    expect((await b.get<Page<GameView>>("/games?status=all")).body.items).toEqual([]);
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM games WHERE owner_user_id = (SELECT id FROM users WHERE username_normalized = 'importer_b')").get()).toEqual({ n: 0 });
    t.db.raw.prepare("UPDATE games SET status = 'completed' WHERE id = ?").run(g.id);
    const board = await b.get<Page<LeaderboardEntry>>("/leaderboards?kind=casual");
    expect(board.body.items.map((e) => e.displayName)).toEqual(["exporter_a"]);
    // an empty (just-started) replay is valid too
    const fresh = (await a.post<GameView>("/games", { mode: "classic" })).body;
    const empty = (await a.get<ReplayView>(`/replays/${fresh.id}`)).body;
    expect((await b.post("/replays/import", empty)).status).toBe(201);
  });

  it("rejects tampered, malformed, unsupported and oversize imports before installing anything (REP-03)", async () => {
    const t = await startApp();
    const a = await user(t, "tamperer");
    let g = (await a.post<GameView>("/games", { mode: "classic" })).body;
    g = await play(a, g, 10);
    const good = (await a.get<ReplayView>(`/replays/${g.id}`)).body;
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    const post = (body: unknown) => a.post<ErrorBody>("/replays/import", body);
    const count = () => t.db.raw.prepare("SELECT count(*) AS n FROM replay_imports").get() as { n: number };

    const flipped = clone();
    (flipped.moves as { checksum: string }[])[4]!.checksum = "0".repeat(64);
    let r = await post(flipped);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("IMPORT_INVALID");
    expect(r.body.error.message).toMatch(/move 5/i);

    const dirs = clone();
    const m0 = (dirs.moves as { direction: string }[])[0]!;
    m0.direction = m0.direction === "left" ? "right" : "left";
    r = await post(dirs);
    expect(r.body.error.code).toBe("IMPORT_INVALID");

    const score = clone();
    score.finalScore = "123";
    expect((await post(score)).body.error.code).toBe("IMPORT_INVALID");
    const scoreBad = clone();
    scoreBad.finalScore = "01";
    expect((await post(scoreBad)).body.error.code).toBe("IMPORT_INVALID");

    const v2 = clone();
    v2.schemaVersion = 2;
    r = await post(v2);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("REPLAY_VERSION_UNSUPPORTED");
    const eng = clone();
    eng.engineVersion = "engine-9.9.9";
    expect((await post(eng)).body.error.code).toBe("REPLAY_VERSION_UNSUPPORTED");
    const rules = clone();
    rules.rulesetVersion = "mystery-v7";
    expect((await post(rules)).body.error.code).toBe("REPLAY_VERSION_UNSUPPORTED");
    const mismatch = clone();
    (mismatch.ruleset as { boardSize: number }).boardSize = 8;
    expect((await post(mismatch)).body.error.code).toBe("IMPORT_INVALID");

    const extra = clone();
    extra.account = { id: "x", sessionToken: "secret" };
    expect((await post(extra)).body.error.code).toBe("IMPORT_INVALID");
    const missing = clone();
    delete missing.seed;
    expect((await post(missing)).body.error.code).toBe("IMPORT_INVALID");
    expect((await post([1, 2, 3])).body.error.code).toBe("IMPORT_INVALID");
    expect((await post("not json at all")).status).toBe(400);
    const gap = clone();
    (gap.moves as { sequence: number }[])[3]!.sequence = 9;
    expect((await post(gap)).body.error.code).toBe("IMPORT_INVALID");
    const snap = clone();
    (snap.snapshots as { checksum: string }[])[0]!.checksum = "f".repeat(64);
    expect((await post(snap)).body.error.code).toBe("IMPORT_INVALID");

    // oversize: rejected on size alone, with the import error code
    const huge = clone();
    huge.padding = "x".repeat(17 * 1024 * 1024);
    r = await post(huge);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("IMPORT_INVALID");
    expect(r.body.error.message).toMatch(/too large/i);
    expect(count().n).toBe(0);
    expect((await post(good)).status).toBe(201);
    expect(count().n).toBe(1);
  });
});
