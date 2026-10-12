import { describe, expect, it } from "vitest";
import { DIRECTIONS } from "@2048/contracts";
import type { Board } from "@2048/contracts";
import { slide as engineSlide, legalMoves } from "@2048/engine";
import { evaluate } from "../src/evaluate.ts";
import { legalDirectionIndexes, newStats, slide, toGrid } from "../src/sim.ts";
import { DEAD_BOARD, boardOf, lcg, randomBoard } from "./helpers.ts";

const gridToCells = (g: Int32Array) => Array.from(g, (v) => (v === 0 ? null : String(v)));

describe("bot simulation matches the engine slide", () => {
  it("agrees on board, change flag and exact score delta for random boards of every size", () => {
    const rand = lcg(7);
    let checked = 0;
    for (let size = 3; size <= 8; size++) {
      for (let t = 0; t < 120; t++) {
        const board = randomBoard(rand, size, 0.3 + rand() * 0.7, 1 + Math.floor(rand() * 6));
        const { grid, n } = toGrid(board);
        const stats = newStats(n);
        const out = new Int32Array(grid.length);
        DIRECTIONS.forEach((dir, d) => {
          const ref = engineSlide(board, dir);
          const changed = slide(grid, out, n, d, stats);
          expect(changed).toBe(ref.changed);
          expect(gridToCells(out)).toEqual(ref.board.cells);
          let gain = 0n;
          for (let i = 0; i < stats.mergedCount; i++) gain += 1n << BigInt(stats.merged[i]!);
          expect(gain.toString()).toBe(ref.scoreDelta);
          checked++;
        });
      }
    }
    expect(checked).toBe(6 * 120 * 4);
  });

  it("legal directions equal the engine's legalMoves (same order)", () => {
    const rand = lcg(11);
    for (let t = 0; t < 300; t++) {
      const board = randomBoard(rand, 3 + (t % 4), 0.5 + rand() * 0.5, 4);
      const { grid, n } = toGrid(board);
      expect(legalDirectionIndexes(grid, n).map((i) => DIRECTIONS[i])).toEqual(legalMoves(board));
    }
    const { grid, n } = toGrid(DEAD_BOARD);
    expect(legalDirectionIndexes(grid, n)).toEqual([]);
  });

  it("merges each tile once: [1,1,1,1] left => [2,2]", () => {
    const { grid, n } = toGrid(boardOf([[1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
    const out = new Int32Array(16);
    slide(grid, out, n, 3, newStats(n));
    expect(Array.from(out.slice(0, 4))).toEqual([2, 2, 0, 0]);
  });

  it("rejects malformed boards and exponents beyond the resource guard", () => {
    expect(() => toGrid({ size: 4, cells: [] })).toThrow();
    expect(() => toGrid({ size: 2, cells: [null, null, null, null] })).toThrow();
    const huge: Board = { size: 3, cells: ["12345678", ...Array(8).fill(null)] };
    expect(() => toGrid(huge)).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
    expect(() => toGrid({ size: 3, cells: ["01", ...Array(8).fill(null)] })).toThrow();
  });

  it("static evaluation prefers more empties and ordered boards", () => {
    const sparse = toGrid(boardOf([[5, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
    const crowded = toGrid(boardOf([[5, 3, 7, 2], [1, 4, 2, 6], [3, 1, 5, 2], [4, 6, 1, 3]]));
    expect(evaluate(sparse.grid, 4)).toBeGreaterThan(evaluate(crowded.grid, 4));
    const ordered = toGrid(boardOf([[6, 5, 4, 3], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
    const scrambled = toGrid(boardOf([[4, 6, 3, 5], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
    expect(evaluate(ordered.grid, 4)).toBeGreaterThan(evaluate(scrambled.grid, 4));
  });
});
