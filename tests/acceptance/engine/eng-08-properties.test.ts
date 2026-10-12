// ENG-08 | Property/fuzz checks
// Pass evidence: mass conservation before spawn; score delta equals merged values;
// transpose/rotation consistency. fast-check with a fixed seed for reproducibility.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DIRECTIONS, practiceRuleset } from "@g2048/contracts";
import type { Board, Cell, Direction } from "@g2048/contracts";
import { E } from "./engine-api.js";
import {
  ROTATE_CW_DIRECTION,
  TRANSPOSE_DIRECTION,
  frozen,
  mass,
  rotateCw,
  tileCount,
  transpose,
} from "./helpers.js";

const SEED = 20261012;
const RUNS = 300;

const cellArb: fc.Arbitrary<Cell> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 6 }).map(String) },
  { weight: 1, arbitrary: fc.integer({ min: 7, max: 300 }).map(String) },
);
const boardArb: fc.Arbitrary<Board> = fc
  .integer({ min: 3, max: 8 })
  .chain((size) =>
    fc.array(cellArb, { minLength: size * size, maxLength: size * size }).map((cells) => ({ size, cells })),
  );
const directionArb = fc.constantFrom<Direction>(...DIRECTIONS);
const opts = { seed: SEED, numRuns: RUNS };

describe("ENG-08 property/fuzz checks", () => {
  it("mass (sum of 2^e) is conserved by slide, before any spawn", () => {
    fc.assert(
      fc.property(boardArb, directionArb, (b, d) => {
        const res = E.slide(frozen(b), d);
        expect(mass(res.board)).toBe(mass(b));
      }),
      opts,
    );
  });

  it("scoreDelta equals the sum of merged values; each merge removes exactly one tile", () => {
    fc.assert(
      fc.property(boardArb, directionArb, (b, d) => {
        const res = E.slide(frozen(b), d);
        let sum = 0n;
        let merges = 0;
        for (const e of res.events) {
          if (e.type !== "tile.merged") continue;
          merges++;
          expect(e.value).toBe((1n << BigInt(e.exponent)).toString());
          expect(res.board.cells[e.to]).toBe(e.exponent);
          sum += BigInt(e.value);
        }
        expect(res.scoreDelta).toBe(sum.toString());
        expect(tileCount(b) - tileCount(res.board)).toBe(merges);
      }),
      opts,
    );
  });

  it("rotation consistency: rotate(slide(b, d)) == slide(rotate(b), rotate(d))", () => {
    fc.assert(
      fc.property(boardArb, directionArb, (b, d) => {
        const a = E.slide(frozen(b), d);
        const r = E.slide(frozen(rotateCw(b)), ROTATE_CW_DIRECTION[d]);
        expect(r.board).toEqual(rotateCw(a.board));
        expect(r.scoreDelta).toBe(a.scoreDelta);
        expect(r.changed).toBe(a.changed);
      }),
      opts,
    );
  });

  it("transpose consistency: transpose(slide(b, d)) == slide(transpose(b), transpose(d))", () => {
    fc.assert(
      fc.property(boardArb, directionArb, (b, d) => {
        const a = E.slide(frozen(b), d);
        const t = E.slide(frozen(transpose(b)), TRANSPOSE_DIRECTION[d]);
        expect(t.board).toEqual(transpose(a.board));
        expect(t.scoreDelta).toBe(a.scoreDelta);
      }),
      opts,
    );
  });

  it("changed is true iff the board differs; legalMoves lists exactly the changing directions in order", () => {
    fc.assert(
      fc.property(boardArb, (b) => {
        const fb = frozen(b);
        const changing = DIRECTIONS.filter((d) => {
          const res = E.slide(fb, d);
          expect(res.changed).toBe(JSON.stringify(res.board.cells) !== JSON.stringify(b.cells));
          return res.changed;
        });
        expect(E.legalMoves(fb)).toEqual(changing);
        expect(E.isGameOver(fb)).toBe(changing.length === 0 && b.cells.every((c) => c !== null));
      }),
      opts,
    );
  });

  it("applyMove: changed moves conserve mass plus exactly one spawned 2 or 4; no-ops change nothing", () => {
    const gameArb = fc.record({
      seed: fc.string({ minLength: 1, maxLength: 16 }),
      size: fc.integer({ min: 3, max: 8 }),
      fourWeight: fc.integer({ min: 0, max: 10 }),
      moves: fc.array(directionArb, { minLength: 1, maxLength: 40 }),
    });
    fc.assert(
      fc.property(gameArb, ({ seed, size, fourWeight, moves }) => {
        const rules = practiceRuleset({ size, fourWeight, undo: true });
        let state = frozen(E.newGame(rules, seed));
        expect(tileCount(state.board)).toBe(2);
        for (const d of moves) {
          if (state.status !== "active") break;
          const res = E.applyMove(state, d, rules);
          if (!res.changed) {
            expect(res.state).toEqual(state);
            continue;
          }
          const spawned = res.events.filter((e) => e.type === "tile.spawned");
          expect(spawned).toHaveLength(1);
          const s = spawned[0];
          if (s?.type !== "tile.spawned") throw new Error("unreachable");
          if (fourWeight === 0) expect(s.exponent).toBe("1");
          if (fourWeight === 10) expect(s.exponent).toBe("2");
          expect(mass(res.state.board)).toBe(mass(state.board) + (1n << BigInt(s.exponent)));
          expect(BigInt(res.state.score)).toBe(BigInt(state.score) + BigInt(res.scoreDelta));
          state = frozen(res.state);
        }
      }),
      { seed: SEED, numRuns: 150 },
    );
  });
});
