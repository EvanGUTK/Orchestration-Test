// ENG-05 (server side) | Exponents 54/256/4096 and score > 2^53 survive HTTP + SQLite exactly.
// RANK-04 | Client posts forged score/state — server derives the result; claimed values are not trusted.
// High values cannot be reached by play, so the game is seeded with seedGameState (TEST-ONLY, written
// against migration 001; see helpers/games.ts) and then driven through the public API.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULESETS } from "@g2048/contracts";
import type { Direction, GameState } from "@g2048/contracts";
import { applyMove, legalMoves, newGame } from "@g2048/engine";
import { createTestApp } from "./helpers/app.js";
import type { TestApp } from "./helpers/app.js";
import { cmd, createGame, gameRow, getGame, move, moveRows, seedGameState } from "./helpers/games.js";
import { Client, expectErrorEnvelope } from "./helpers/http.js";

type HighValue = {
  before: { state: GameState };
  applyMove: { scoreDelta: string; after: { state: GameState; checksum: string } };
};
const VECTORS = JSON.parse(
  readFileSync(new URL("../acceptance/vectors/engine-v1.json", import.meta.url), "utf8"),
) as { highValue: HighValue };

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe("ENG-05 exact high values through HTTP and SQLite", () => {
  it("53+53 and 4095+4095 merge server-side to the oracle's exact state, score and 1234-digit delta", async () => {
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "eng05-server" });
    const seeded = VECTORS.highValue.before.state;
    seedGameState(t.db, g.game.id, seeded);
    expect((await getGame(c, g.game.id)).state, "GET returns the seeded state verbatim").toEqual(seeded);

    const r = await move(c, g.game.id, "left", 0);
    expect(r.status, r.text).toBe(200);
    expect(r.json.scoreDelta).toBe(VECTORS.highValue.applyMove.scoreDelta);
    expect(r.json.scoreDelta).toHaveLength(1234);
    expect(r.json.state).toEqual(VECTORS.highValue.applyMove.after.state);
    expect(r.text, "raw JSON carries decimal strings, never exponent notation").not.toMatch(/\d[eE][+-]?\d/);

    const row = gameRow(t.db, g.game.id);
    expect(row.score).toBe(VECTORS.highValue.applyMove.after.state.score);
    expect(row.state_checksum).toBe(VECTORS.highValue.applyMove.after.checksum);
    const types = t.db
      .prepare("SELECT typeof(score) AS s, typeof(max_exponent) AS m FROM games WHERE id = ?")
      .get(g.game.id);
    expect(types).toEqual({ s: "text", m: "text" });
    expect(moveRows(t.db, g.game.id)[0]?.score_delta).toBe(VECTORS.highValue.applyMove.scoreDelta);
    expect((await getGame(c, g.game.id)).state).toEqual(VECTORS.highValue.applyMove.after.state);
    expect((await getGame(c, g.game.id)).game.maxExponent).toBe("4096");
  });

  it("a score just above 2^53 accumulates exactly; exponent 256 merges exactly", async () => {
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "eng05-2-53" });
    const base = newGame(RULESETS["classic-v1"], "eng05-2-53");
    const cells = Array<string | null>(16).fill(null);
    cells[0] = "255";
    cells[1] = "255";
    cells[15] = "1";
    const seeded: GameState = {
      ...base,
      board: { size: 4, cells },
      score: "9007199254740993",
      celebrated2048: true,
    };
    seedGameState(t.db, g.game.id, seeded);
    const r = await move(c, g.game.id, "left", 0);
    expect(r.status, r.text).toBe(200);
    const expected = applyMove(seeded, "left", RULESETS["classic-v1"]);
    expect(r.json.state).toEqual(expected.state);
    expect(r.json.state.score).toBe((9007199254740993n + (1n << 256n)).toString());
    expect(r.json.state.board.cells[0]).toBe("256");
  });
});

describe("RANK-04 client-posted score is never trusted", () => {
  it("forged score/state/delta fields on a move are rejected or ignored; the server derives the result", async () => {
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "rank04-move" });
    const d = legalMoves(g.state.board)[0] as Direction;
    const forged = {
      commandId: cmd("forge"),
      expectedRevision: 0,
      direction: d,
      score: "999999999999",
      scoreDelta: "999999999999",
      state: { ...g.state, score: "999999999999" },
    };
    const r = await c.post<{ state: GameState }>(`/games/${g.game.id}/moves`, forged);
    const truth = applyMove(g.state, d, RULESETS["classic-v1"]).state;
    if (r.status === 400) {
      expectErrorEnvelope(r, "VALIDATION_ERROR");
      expect((await getGame(c, g.game.id)).state).toEqual(g.state);
    } else {
      expect(r.status, r.text).toBe(200);
      expect(r.json.state).toEqual(truth);
    }
    expect((await getGame(c, g.game.id)).state.score).not.toBe("999999999999");
  });

  it("forged score/state on game creation are rejected or ignored", async () => {
    const c = new Client(t.app);
    const r = await c.post<{ state: GameState }>("/games", {
      mode: "classic",
      seed: "rank04-create",
      score: "123456789",
      state: { score: "123456789" },
    });
    if (r.status === 400) expectErrorEnvelope(r, "VALIDATION_ERROR");
    else {
      expect(r.status, r.text).toBe(201);
      expect(r.json.state).toEqual(newGame(RULESETS["classic-v1"], "rank04-create"));
    }
  });
});
