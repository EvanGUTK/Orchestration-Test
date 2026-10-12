// ENG-01 | All four directions, empty/full/alternating boards
// Pass evidence: correct board and exact score; input unchanged.
import { describe, expect, it } from "vitest";
import { DIRECTIONS } from "@g2048/contracts";
import type { Board, Direction } from "@g2048/contracts";
import { E } from "./engine-api.js";
import { CLASSIC, frozen, makeState, rows } from "./helpers.js";

type Case = { name: string; before: Board; expected: Record<Direction, { after: Board; delta: string }> };

const EMPTY4 = rows(". . . .", ". . . .", ". . . .", ". . . .");
const CHECKER = rows("1 2 1 2", "2 1 2 1", "1 2 1 2", "2 1 2 1");
const ALL_ONES = rows("1 1 1 1", "1 1 1 1", "1 1 1 1", "1 1 1 1");
const PAIRS = rows("1 1 2 2", "1 1 2 2", "1 1 2 2", "1 1 2 2");
const SINGLE = rows(". . . .", ". 3 . .", ". . . .", ". . . .");

const unchanged = (b: Board) =>
  Object.fromEntries(DIRECTIONS.map((d) => [d, { after: b, delta: "0" }])) as Case["expected"];

const CASES: Case[] = [
  { name: "empty 4x4", before: EMPTY4, expected: unchanged(EMPTY4) },
  { name: "full alternating (checkerboard) 4x4", before: CHECKER, expected: unchanged(CHECKER) },
  {
    name: "full equal 4x4",
    before: ALL_ONES,
    expected: {
      left: { after: rows("2 2 . .", "2 2 . .", "2 2 . .", "2 2 . ."), delta: "32" },
      right: { after: rows(". . 2 2", ". . 2 2", ". . 2 2", ". . 2 2"), delta: "32" },
      up: { after: rows("2 2 2 2", "2 2 2 2", ". . . .", ". . . ."), delta: "32" },
      down: { after: rows(". . . .", ". . . .", "2 2 2 2", "2 2 2 2"), delta: "32" },
    },
  },
  {
    name: "full alternating pairs 4x4",
    before: PAIRS,
    expected: {
      left: { after: rows("2 3 . .", "2 3 . .", "2 3 . .", "2 3 . ."), delta: "48" },
      right: { after: rows(". . 2 3", ". . 2 3", ". . 2 3", ". . 2 3"), delta: "48" },
      up: { after: rows("2 2 3 3", "2 2 3 3", ". . . .", ". . . ."), delta: "48" },
      down: { after: rows(". . . .", ". . . .", "2 2 3 3", "2 2 3 3"), delta: "48" },
    },
  },
  {
    name: "single tile 4x4",
    before: SINGLE,
    expected: {
      left: { after: rows(". . . .", "3 . . .", ". . . .", ". . . ."), delta: "0" },
      right: { after: rows(". . . .", ". . . 3", ". . . .", ". . . ."), delta: "0" },
      up: { after: rows(". 3 . .", ". . . .", ". . . .", ". . . ."), delta: "0" },
      down: { after: rows(". . . .", ". . . .", ". . . .", ". 3 . ."), delta: "0" },
    },
  },
  {
    name: "3x3 mixed",
    before: rows("1 . 1", "1 2 .", "2 2 2"),
    expected: {
      left: { after: rows("2 . .", "1 2 .", "3 2 ."), delta: "12" },
      right: { after: rows(". . 2", ". 1 2", ". 2 3"), delta: "12" },
      up: { after: rows("2 3 1", "2 . 2", ". . ."), delta: "12" },
      down: { after: rows(". . .", "2 . 1", "2 3 2"), delta: "12" },
    },
  },
  {
    name: "8x8 full row of ones",
    before: rows(
      "1 1 1 1 1 1 1 1",
      ". . . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
    ),
    expected: {
      left: {
        after: rows(
          "2 2 2 2 . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
        ),
        delta: "16",
      },
      right: {
        after: rows(
          ". . . . 2 2 2 2",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
        ),
        delta: "16",
      },
      up: {
        after: rows(
          "1 1 1 1 1 1 1 1",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
        ),
        delta: "0",
      },
      down: {
        after: rows(
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          ". . . . . . . .",
          "1 1 1 1 1 1 1 1",
        ),
        delta: "0",
      },
    },
  },
];

describe("ENG-01 all four directions on empty/full/alternating boards", () => {
  for (const c of CASES) {
    for (const direction of DIRECTIONS) {
      it(`${c.name}: ${direction} gives the exact board and score delta; input unchanged`, () => {
        const input = frozen(c.before);
        const snapshot = JSON.stringify(input);
        const res = E.slide(input, direction);
        const want = c.expected[direction];
        expect(res.board).toEqual(want.after);
        expect(res.scoreDelta).toBe(want.delta);
        expect(typeof res.scoreDelta).toBe("string");
        expect(res.changed).toBe(JSON.stringify(want.after.cells) !== JSON.stringify(c.before.cells));
        expect(JSON.stringify(input)).toBe(snapshot);
      });
    }
  }

  it("applyMove adds the exact delta to the decimal score and leaves the input state unchanged", () => {
    const state = frozen(makeState(PAIRS.cells, { score: "100", acceptedMoves: 3, revision: 3 }));
    const snapshot = JSON.stringify(state);
    const res = E.applyMove(state, "left", CLASSIC);
    expect(res.changed).toBe(true);
    expect(res.scoreDelta).toBe("48");
    expect(res.state.score).toBe("148");
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(res.state).not.toBe(state);
  });

  it('no-op on an empty or locked direction reports changed:false with delta "0"', () => {
    for (const b of [EMPTY4, CHECKER]) {
      for (const d of DIRECTIONS) {
        const res = E.slide(frozen(b), d);
        expect(res.changed).toBe(false);
        expect(res.scoreDelta).toBe("0");
        expect(res.events).toEqual([]);
      }
    }
  });
});
