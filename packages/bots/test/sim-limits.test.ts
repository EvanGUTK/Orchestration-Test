import { describe, expect, it } from "vitest";
import { DIRECTIONS, MAX_EXPONENT_DIGITS } from "@2048/contracts";
import type { Board, Cell } from "@2048/contracts";
import { legalMoves, slide as engineSlide } from "@2048/engine";
import { BOT_LIMITS, chooseMove, defaultBotConfig } from "../src/index.ts";
import { evaluate } from "../src/evaluate.ts";
import { MAX_SIM_CELL, MAX_SIM_EXPONENT, SIM_GROWTH_MARGIN, newStats, slide, toGrid } from "../src/sim.ts";
import { lcg } from "./helpers.ts";

// Engine rule (packages/engine/src/slide.ts): a merge producing an exponent above this throws RESOURCE_LIMIT.
const ENGINE_MAX_MERGE_EXPONENT = 1_000_000;

describe("Number safety of the exponent simulator", () => {
  it("documented bound: guard + growth margin stays far below Int32 and 2^53", () => {
    expect(MAX_SIM_EXPONENT).toBe(10 ** MAX_EXPONENT_DIGITS - 1);
    expect(MAX_SIM_CELL).toBe(MAX_SIM_EXPONENT + SIM_GROWTH_MARGIN);
    expect(MAX_SIM_CELL).toBeLessThan(2 ** 31 - 1);
    expect(MAX_SIM_CELL).toBeLessThan(Number.MAX_SAFE_INTEGER);
    // growth within one search: +1 per ply at most, plies <= 2 * maxDepth (move + spawn per level)
    expect(2 * BOT_LIMITS.maxDepth).toBeLessThanOrEqual(SIM_GROWTH_MARGIN);
  });

  it("the entry guard accepts exactly the 7-digit limit and rejects beyond, on every entry path", () => {
    const at = (e: string): Board => ({ size: 3, cells: [e, ...Array<Cell>(8).fill(null)] });
    expect(toGrid(at(String(MAX_SIM_EXPONENT))).grid[0]).toBe(MAX_SIM_EXPONENT);
    for (const bad of [String(MAX_SIM_EXPONENT + 1), "123456789012345678901234567890", "9007199254740993"]) {
      expect(() => toGrid(at(bad))).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
      // chooseMove (and therefore BotGame / worker / tournament) all enter through toGrid
      expect(() => chooseMove(at(bad), defaultBotConfig("expectimax", "s"))).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
      for (const strategy of ["random", "greedy", "heuristic"] as const) {
        expect(() => chooseMove(at(bad), defaultBotConfig(strategy, "s"))).toThrow();
      }
    }
  });

  it("exact growth: a merge at the limit yields limit+1 with no precision loss, and Int32 holds the margin", () => {
    const { grid } = toGrid({ size: 3, cells: [String(MAX_SIM_EXPONENT), String(MAX_SIM_EXPONENT), ...Array<Cell>(7).fill(null)] });
    const out = new Int32Array(9);
    const stats = newStats(3);
    slide(grid, out, 3, 3, stats);
    expect(out[0]).toBe(MAX_SIM_EXPONENT + 1);
    expect(stats.merged[0]).toBe(MAX_SIM_EXPONENT + 1);
    const typed = new Int32Array([MAX_SIM_CELL]);
    expect(typed[0]).toBe(MAX_SIM_CELL);
  });

  it("evaluation stays finite for a board full of maximum-size exponents", () => {
    const grid = new Int32Array(64).fill(MAX_SIM_CELL);
    expect(Number.isFinite(evaluate(grid, 8))).toBe(true);
  });

  it("agrees with engine.slide on large exponents up to the engine merge limit, all sizes and directions", () => {
    const rand = lcg(2024);
    // mostly modest exponents; large ones (up to the engine limit) are rarer because the engine computes exact BigInt scores
    const expsPool = [1, 2, 11, 12, 63, 64, 65, 1023, 1024, 4096, 4097, 20_000, 20_000, 99_999, 999_999, 999_999];
    let checked = 0;
    for (let size = 3; size <= 8; size++) {
      for (let t = 0; t < 8; t++) {
        const cells: Cell[] = [];
        for (let i = 0; i < size * size; i++) {
          cells.push(rand() < 0.5 ? String(expsPool[Math.floor(rand() * expsPool.length)]!) : null);
        }
        const board: Board = { size, cells };
        // merges of two 999,999 tiles give 1,000,000 (allowed); a pair of 1,000,000 would exceed the engine limit, none present
        const { grid, n } = toGrid(board);
        const out = new Int32Array(grid.length);
        const stats = newStats(n);
        DIRECTIONS.forEach((dir, d) => {
          const ref = engineSlide(board, dir);
          expect(slide(grid, out, n, d, stats)).toBe(ref.changed);
          expect(Array.from(out, (v) => (v === 0 ? null : String(v)))).toEqual(ref.board.cells);
          let gain = 0n;
          for (let i = 0; i < stats.mergedCount; i++) gain += 1n << BigInt(stats.merged[i]!);
          expect(gain.toString()).toBe(ref.scoreDelta); // exact BigInt score from 2^999,999-sized tiles
          checked++;
        });
      }
    }
    expect(checked).toBe(6 * 8 * 4);
  }, 120_000);

  it("the engine refuses merges past 1,000,000 while the simulator keeps counting (documented difference)", () => {
    const board: Board = { size: 3, cells: ["1000000", "1000000", ...Array<Cell>(7).fill(null)] };
    expect(() => engineSlide(board, "left")).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
    const { grid } = toGrid(board);
    const out = new Int32Array(9);
    slide(grid, out, 3, 3, newStats(3));
    expect(out[0]).toBe(ENGINE_MAX_MERGE_EXPONENT + 1);
  });

  it("chooseMove works on boards holding very large (but in-limit) tiles", () => {
    const board: Board = { size: 4, cells: ["999999", "999998", "5", null, null, "3", null, null, null, null, "2", null, null, null, null, "1"] };
    for (const strategy of ["random", "greedy", "heuristic", "expectimax"] as const) {
      const d = chooseMove(board, { ...defaultBotConfig(strategy, "big"), nodeBudget: 500 }, { ignoreTimeBudget: true });
      expect(legalMoves(board)).toContain(d.direction);
    }
  });
});
