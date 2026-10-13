// SOLO-01 | New guest/account game; save/resume — correct initial state and durable progress.
// SOLO-02 | Custom sizes/seed/settings — 3x3..8x8; invalid sizes rejected; custom results casual.
// SOLO-03 | Casual undo — restores score/board/PRNG; history limit; replay remains coherent.
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_VERSION, REPLAY_SCHEMA_VERSION, RULESETS, practiceRuleset } from "@g2048/contracts";
import type { Direction, GameResponse, GameState, ReplayFile, Ruleset } from "@g2048/contracts";
import { applyMove, legalMoves, newGame, verifyReplay } from "@g2048/engine";
import { createTestApp, makeTempDir, openTestApp } from "./helpers/app.js";
import type { TestApp } from "./helpers/app.js";
import { cmd, createGame, getGame, legalMove, move, undo } from "./helpers/games.js";
import { Client, expectErrorEnvelope } from "./helpers/http.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Plays n legal moves through the API, mirroring each with the engine; returns states [0..n]. */
async function playMirrored(
  c: Client,
  id: string,
  start: GameState,
  n: number,
  rules: Ruleset = RULESETS["classic-v1"],
) {
  const states = [start];
  let s = start;
  for (let i = 0; i < n && s.status === "active"; i++) {
    const d = legalMoves(s.board)[i % legalMoves(s.board).length] as Direction;
    const r = await move(c, id, d, s.revision);
    expect(r.status, r.text).toBe(200);
    const expected = applyMove(s, d, rules);
    expect(r.json.state, `move ${i + 1} (${d})`).toEqual(expected.state);
    expect(r.json.scoreDelta).toBe(expected.scoreDelta);
    s = r.json.state;
    states.push(s);
  }
  return states;
}

const sameGame = (a: GameState, b: GameState) => {
  expect(a.board).toEqual(b.board);
  expect(a.score).toBe(b.score);
  expect(a.rng).toEqual(b.rng);
  expect(a.acceptedMoves).toBe(b.acceptedMoves);
  expect(a.status).toBe(b.status);
  expect(a.celebrated2048).toBe(b.celebrated2048);
};

describe("SOLO-01 new game, save and resume via the API", () => {
  it("seeded classic guest game: initial state and every move equal the engine", async () => {
    t = await createTestApp();
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "solo01-api" });
    expect(g.state).toEqual(newGame(RULESETS["classic-v1"], "solo01-api"));
    expect(g.game).toMatchObject({
      mode: "classic",
      rulesetVersion: "classic-v1",
      status: "active",
      score: "0",
      revision: 0,
    });
    await playMirrored(c, g.game.id, g.state, 15);
  });

  it("progress is durable across an application restart on the same database", async () => {
    const tmp = makeTempDir();
    const path = `${tmp.dir}/game.sqlite3`;
    let { app, db } = await openTestApp(path);
    try {
      const c = new Client(app);
      const g = await createGame(c, { mode: "classic", seed: "solo01-durable" });
      const states = await playMirrored(c, g.game.id, g.state, 8);
      await app.close();
      db.close();
      ({ app, db } = await openTestApp(path));
      const c2 = new Client(app);
      for (const [k, v] of c.jar) c2.jar.set(k, v);
      expect((await getGame(c2, g.game.id)).state).toEqual(states.at(-1));
    } finally {
      await app.close();
      db.close();
      tmp.cleanup();
    }
  });

  it("an account's games appear in its resumable list with exact decimal summaries", async () => {
    t = await createTestApp();
    const c = new Client(t.app);
    await c.signUp("solo_owner");
    const g = await createGame(c, { mode: "classic", seed: "solo01-list" });
    const states = await playMirrored(c, g.game.id, g.state, 5);
    const list = await c.get<{ items: GameResponse["game"][]; nextCursor: string | null }>("/games");
    expect(list.status).toBe(200);
    const mine = list.json.items.find((x) => x.id === g.game.id);
    expect(mine).toMatchObject({
      score: states.at(-1)?.score,
      acceptedMoves: states.at(-1)?.acceptedMoves,
      status: "active",
    });
    expect(typeof mine?.score).toBe("string");
  });
});

describe("SOLO-02 custom practice sizes, seed and settings", () => {
  for (const size of [3, 4, 5, 6, 7, 8]) {
    it(`${size}x${size} practice game starts from the engine's seeded state`, async () => {
      t = await createTestApp();
      const c = new Client(t.app);
      const seed = `solo02-${size}`;
      const g = await createGame(c, {
        mode: "practice",
        practice: { size, fourWeight: 3, seed, undo: true },
      });
      const rules = practiceRuleset({ size, fourWeight: 3, undo: true });
      expect(g.state).toEqual(newGame(rules, seed));
      expect(g.game).toMatchObject({ mode: "practice", rulesetVersion: "practice-v1" });
      await playMirrored(c, g.game.id, g.state, 4, rules);
    });
  }

  it.each([
    ["size 2", { size: 2 }],
    ["size 9", { size: 9 }],
    ["size 0", { size: 0 }],
    ["fractional size", { size: 4.5 }],
    ["string size", { size: "4" }],
    ["fourWeight 11", { size: 4, fourWeight: 11 }],
    ["negative fourWeight", { size: 4, fourWeight: -1 }],
    ["empty seed", { size: 4, seed: "" }],
    ["129-char seed", { size: 4, seed: "s".repeat(129) }],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, practice) => {
    t = await createTestApp();
    const c = new Client(t.app);
    const r = await c.post("/games", { mode: "practice", practice });
    expect(r.status, r.text).toBe(400);
    expectErrorEnvelope(r, "VALIDATION_ERROR");
  });

  it("practice results stay casual: never in challenge or classic casual standings", async () => {
    t = await createTestApp();
    const c = new Client(t.app);
    await c.signUp("practicer");
    const g = await createGame(c, { mode: "practice", practice: { size: 4, seed: "solo02-casual" } });
    await playMirrored(c, g.game.id, g.state, 6, practiceRuleset({ size: 4, fourWeight: 1, undo: true }));
    expect(
      (await c.post(`/games/${g.game.id}/forfeit`, { commandId: cmd("ff"), expectedRevision: 6 })).status,
    ).toBe(200);
    for (const q of [
      "scope=challenge",
      "scope=casual&ruleset=classic-v1",
      "scope=casual&ruleset=ranked-v1",
    ]) {
      const lb = await c.get<{ items: { gameId: string | null }[] }>(`/leaderboards?${q}`);
      expect(lb.status, `${q}: ${lb.text}`).toBe(200);
      expect(lb.json.items.map((e) => e.gameId)).not.toContain(g.game.id);
    }
  });
});

describe("SOLO-03 casual undo", () => {
  it("undo restores board, score, PRNG and counters exactly; the revision still advances", async () => {
    t = await createTestApp();
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "solo03-undo" });
    const states = await playMirrored(c, g.game.id, g.state, 3);
    const u = await undo(c, g.game.id, 3);
    expect(u.status, u.text).toBe(200);
    const now = (await getGame(c, g.game.id)).state;
    expect(u.json.state, "C14: undo returns the restored game's GameResponse").toEqual(now);
    sameGame(now, states[2] as GameState);
    expect(now.revision).toBeGreaterThan(3);
    // the next move follows the restored PRNG stream exactly
    await playMirrored(c, g.game.id, now, 2);
  });

  it("C11: undo with nothing to undo is 400 VALIDATION_ERROR; undo-disabled practice is 403 FORBIDDEN", async () => {
    t = await createTestApp();
    const c = new Client(t.app);
    const fresh = await createGame(c, { mode: "classic", seed: "solo03-empty" });
    const none = await undo(c, fresh.game.id, 0);
    expect(none.status, none.text).toBe(400);
    expectErrorEnvelope(none, "VALIDATION_ERROR");
    expect((await getGame(c, fresh.game.id)).state).toEqual(fresh.state);

    const noUndo = await createGame(c, {
      mode: "practice",
      practice: { size: 4, seed: "solo03-noundo", undo: false },
    });
    const s = await legalMove(c, noUndo.game.id, noUndo.state);
    const denied = await undo(c, noUndo.game.id, s.revision);
    expect(denied.status, denied.text).toBe(403);
    expectErrorEnvelope(denied, "FORBIDDEN");
    expect((await getGame(c, noUndo.game.id)).state).toEqual(s);
  });

  it(
    "history holds 100 undo steps; the 101st is rejected without changing state",
    { timeout: 120_000 },
    async () => {
      t = await createTestApp();
      const c = new Client(t.app);
      const g = await createGame(c, {
        mode: "practice",
        practice: { size: 8, seed: "solo03-limit", undo: true },
      });
      let s = g.state;
      const history: GameState[] = [s];
      for (let i = 0; i < 105; i++) {
        s = await legalMove(c, g.game.id, s, i);
        history.push(s);
      }
      for (let i = 1; i <= 100; i++) {
        const u = await undo(c, g.game.id, s.revision);
        expect(u.status, `undo ${i}: ${u.text}`).toBe(200);
        s = (await getGame(c, g.game.id)).state;
        sameGame(s, history[105 - i] as GameState);
      }
      const r = await getGame(c, g.game.id);
      expect(r.canUndo).toBe(false);
      const extra = await undo(c, g.game.id, s.revision);
      // CONTRACT-001 C11: beyond the history limit -> 400 VALIDATION_ERROR, state unchanged
      expect(extra.status, extra.text).toBe(400);
      expectErrorEnvelope(extra, "VALIDATION_ERROR");
      expect((await getGame(c, g.game.id)).state).toEqual(s);
    },
  );

  it("after undo, the exported replay excludes undone moves and verifies with the engine", async () => {
    t = await createTestApp();
    const c = new Client(t.app);
    await c.signUp("undo_replayer");
    const g = await createGame(c, { mode: "classic", seed: "solo03-replay" });
    let s = (await playMirrored(c, g.game.id, g.state, 6)).at(-1) as GameState;
    expect((await undo(c, g.game.id, s.revision)).status).toBe(200);
    s = (await getGame(c, g.game.id)).state;
    s = (await playMirrored(c, g.game.id, s, 3)).at(-1) as GameState;
    const rep = await c.get<ReplayFile>(`/replays/${g.game.id}`);
    expect(rep.status, rep.text).toBe(200);
    expect(rep.json.replaySchemaVersion).toBe(REPLAY_SCHEMA_VERSION);
    expect(rep.json.engineVersion).toBe(ENGINE_VERSION);
    expect(rep.json.moves).toHaveLength(s.acceptedMoves);
    const v = verifyReplay(rep.json, RULESETS["classic-v1"]);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (v.ok) sameGame(v.final, s);
  });
});
