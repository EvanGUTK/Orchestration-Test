// ENG-07 | Game-over detection
// Pass evidence: full unequal board dead; full mergeable board active.
import { describe, expect, it } from "vitest";
import { RULESETS } from "@g2048/contracts";
import type { Direction } from "@g2048/contracts";
import { E } from "./engine-api.js";
import { CLASSIC, expectEngineError, frozen, makeState, rows, transition } from "./helpers.js";

describe("ENG-07 game-over detection", () => {
  it("full board with no equal neighbours is dead; no legal moves", () => {
    const dead = frozen(rows("1 2 1 2", "2 1 2 1", "1 2 1 2", "2 1 2 1"));
    expect(E.isGameOver(dead)).toBe(true);
    expect(E.legalMoves(dead)).toEqual([]);
  });

  it("full board with one horizontal or vertical equal pair is active", () => {
    // only pair: row 3, cols 2-3 (horizontal)
    const horizontal = frozen(rows("1 2 1 2", "2 1 2 1", "1 2 1 2", "2 1 3 3"));
    // only pair: col 0, rows 2-3 (vertical)
    const vertical = frozen(rows("1 2 1 2", "2 1 2 1", "1 2 1 2", "1 3 2 3"));
    expect(E.isGameOver(horizontal)).toBe(false);
    expect(E.legalMoves(horizontal)).toEqual(["right", "left"]);
    expect(E.isGameOver(vertical)).toBe(false);
    expect(E.legalMoves(vertical)).toEqual(["up", "down"]);
    const both = frozen(rows("1 2 1 2", "2 1 2 1", "1 2 1 2", "2 1 2 2"));
    expect(E.legalMoves(both)).toEqual<Direction[]>(["up", "right", "down", "left"]);
  });

  it("a board with an empty cell is never game over", () => {
    expect(E.isGameOver(frozen(rows("1 2 1 2", "2 1 2 1", "1 2 1 2", "2 1 2 .")))).toBe(false);
  });

  it("legalMoves uses the stable order up,right,down,left", () => {
    expect(E.legalMoves(frozen(rows("1 . . .", ". . . .", ". . . .", ". . . .")))).toEqual(["right", "down"]);
    expect(E.legalMoves(frozen(rows(". . . .", ". 1 . .", ". . . .", ". . . .")))).toEqual([
      "up",
      "right",
      "down",
      "left",
    ]);
    expect(E.legalMoves(frozen(rows("1 1 . .", ". . . .", ". . . .", ". . . .")))).toEqual([
      "right",
      "down",
      "left",
    ]);
  });

  it("golden: the move that fills the last cell with no merges left completes the game with game.over last", () => {
    const t = transition("move-completes-game");
    if (!t.before || !t.after || !t.direction) throw new Error("bad vector");
    const res = E.applyMove(frozen(t.before.state), t.direction, CLASSIC);
    expect(res.state).toEqual(t.after.state);
    expect(res.state.status).toBe("completed");
    expect(res.events.at(-1)).toEqual({ type: "game.over" });
    expect(res.events.filter((e) => e.type === "game.over")).toHaveLength(1);
    expect(E.isGameOver(res.state.board)).toBe(true);
  });

  it("golden: completed board has no legal moves; full mergeable board stays active", () => {
    const dead = transition("completed-board-all-noop");
    const live = transition("full-mergeable-board-active");
    if (!dead.board || !live.board) throw new Error("bad vector");
    expect(E.isGameOver(frozen(dead.board))).toBe(true);
    expect(E.legalMoves(frozen(dead.board))).toEqual(dead.legalMoves);
    expect(E.isGameOver(frozen(live.board))).toBe(false);
    expect(E.legalMoves(frozen(live.board))).toEqual(live.legalMoves);
  });

  it("applyMove on a completed or forfeited game throws GAME_NOT_ACTIVE without touching the input", () => {
    for (const status of ["completed", "forfeited"] as const) {
      const state = frozen(makeState(rows("1 1 . .", ". . . .", ". . . .", ". . . .").cells, { status }));
      expectEngineError(() => E.applyMove(state, "left", CLASSIC), "GAME_NOT_ACTIVE");
    }
  });

  it("forfeit() marks the game forfeited and preserves score, board and rng", () => {
    const state = frozen(E.newGame(CLASSIC, "forfeit-me"));
    const f = E.forfeit(state);
    expect(f.status).toBe("forfeited");
    expect(f.score).toBe(state.score);
    expect(f.board).toEqual(state.board);
    expect(f.rng).toEqual(state.rng);
    expect(state.status).toBe("active");
    expectEngineError(() => E.applyMove(frozen(f), "left", CLASSIC), "GAME_NOT_ACTIVE");
  });

  it("ranked moveCap: the 500th accepted move completes the game even with legal moves left", () => {
    const ranked = RULESETS["ranked-v1"];
    const start = E.newGame(ranked, "cap-seed");
    const state = frozen({ ...start, acceptedMoves: 499, revision: 499 });
    const d = E.legalMoves(state.board)[0];
    if (!d) throw new Error("no legal move");
    const res = E.applyMove(state, d, ranked);
    expect(res.changed).toBe(true);
    expect(res.state.acceptedMoves).toBe(500);
    expect(res.state.status).toBe("completed");
    expect(E.isGameOver(res.state.board)).toBe(false);
  });
});
