// Test-only helpers (not exported from the package index).
import { ENGINE_VERSION, RNG_ALGORITHM, SCHEMA_VERSION } from "@g2048/contracts";
import type { Board, Cell, GameState, RandomState } from "@g2048/contracts";
import fc from "fast-check";

export function stateFor(board: Board, rng: RandomState = gameRng(1, 2, 3, 4)): GameState {
  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: board.size === 4 ? "duel-v1" : "practice-v1",
    board,
    score: "0",
    acceptedMoves: 0,
    revision: 0,
    rng,
    status: "active",
    celebrated2048: false,
  };
}

export function gameRng(a: number, b: number, c: number, d: number): RandomState {
  return { algorithm: RNG_ALGORITHM, words: [a >>> 0, b >>> 0, c >>> 0, d >>> 0] };
}

export function board(rows: readonly (readonly (number | null)[])[]): Board {
  const size = rows.length;
  const cells: Cell[] = rows.flat().map((e) => (e === null || e === 0 ? null : String(e)));
  return { size, cells };
}

/** Random boards: size 3..6 (mostly 4), cells empty or exponent 1..maxExp. */
export const arbBoard = (maxExp = 14): fc.Arbitrary<Board> =>
  fc.constantFrom(3, 4, 4, 4, 5, 6).chain((size) =>
    fc
      .array(fc.option(fc.integer({ min: 1, max: maxExp }), { nil: null, freq: 3 }), {
        minLength: size * size,
        maxLength: size * size,
      })
      .map((cells) => ({ size, cells: cells.map((e) => (e === null ? null : String(e))) })),
  );

export const arbRng: fc.Arbitrary<RandomState> = fc
  .tuple(fc.nat(), fc.nat(), fc.nat(), fc.integer({ min: 1, max: 0x7fffffff }))
  .map(([a, b, c, d]) => gameRng(a, b, c, d));
