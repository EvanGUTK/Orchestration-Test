import type { Board } from "@g2048/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EVAL_WEIGHTS, emptyIndexes, evaluateBoard, placeTile, toExponents } from "./evaluate.js";
import { arbBoard, board } from "./test-helpers.js";

function transform(b: Board, map: (row: number, col: number) => [number, number]): Board {
  const cells = b.cells.slice();
  for (let r = 0; r < b.size; r += 1) {
    for (let c = 0; c < b.size; c += 1) {
      const [r2, c2] = map(r, c);
      cells[r2 * b.size + c2] = b.cells[r * b.size + c] ?? null;
    }
  }
  return { size: b.size, cells };
}

describe("evaluateBoard (eval-v1)", () => {
  it("scores an empty board by empties only", () => {
    const empty = board([
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]);
    expect(evaluateBoard(empty)).toBe(9 * EVAL_WEIGHTS.empty);
  });

  it("matches a hand-computed value", () => {
    // Row 0: 3 2 1 0 (monotone), others empty. empties 13; mono 0; smooth |3-2|+|2-1| = 2; corner 3.
    const b = board([
      [3, 2, 1, null],
      [null, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
    ]);
    expect(evaluateBoard(b)).toBe(13 * 270 - 0 * 47 - 2 * 11 + 3 * 100);
  });

  it("prefers sorted, cornered boards over scattered ones", () => {
    const sorted = board([
      [6, 5, 4, 3],
      [null, null, null, 2],
      [null, null, null, null],
      [null, null, null, null],
    ]);
    const scattered = board([
      [3, null, 6, null],
      [null, 5, null, 2],
      [4, null, null, null],
      [null, null, null, null],
    ]);
    expect(evaluateBoard(sorted)).toBeGreaterThan(evaluateBoard(scattered));
  });

  it("is an exact integer, invariant under reflections and transposition", () => {
    fc.assert(
      fc.property(arbBoard(30), (b) => {
        const n = b.size - 1;
        const v = evaluateBoard(b);
        expect(Number.isSafeInteger(v)).toBe(true);
        expect(evaluateBoard(transform(b, (r, c) => [r, n - c]))).toBe(v);
        expect(evaluateBoard(transform(b, (r, c) => [n - r, c]))).toBe(v);
        expect(evaluateBoard(transform(b, (r, c) => [c, r]))).toBe(v);
      }),
      { numRuns: 500 },
    );
  });

  it("helpers place hypothetical tiles without mutating the board", () => {
    const b = Object.freeze(
      board([
        [1, null],
        [null, 2],
      ]),
    );
    const placed = placeTile(b, 1, "2");
    expect(placed.cells).toEqual(["1", "2", null, "2"]);
    expect(b.cells).toEqual(["1", null, null, "2"]);
    expect(emptyIndexes(b)).toEqual([1, 2]);
    expect(toExponents(b)).toEqual([1, 0, 0, 2]);
  });
});
