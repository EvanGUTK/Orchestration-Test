import { practiceRuleset, RULESETS } from "@g2048/contracts";
import type { Board, Cell, Direction, GameState, Ruleset } from "@g2048/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyMove, newGame } from "./game.js";
import { isGameOver, legalMoves, slide } from "./slide.js";

const DIRS: readonly Direction[] = ["up", "right", "down", "left"];

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const exponentArb = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 6 }).map(String) },
  { weight: 2, arbitrary: fc.integer({ min: 7, max: 20 }).map(String) },
  { weight: 1, arbitrary: fc.constantFrom("53", "54", "255", "256", "4095", "4096") },
);
const cellArb: fc.Arbitrary<Cell> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 3, arbitrary: exponentArb },
);

const boardArb: fc.Arbitrary<Board> = fc
  .integer({ min: 3, max: 8 })
  .chain((size) =>
    fc.array(cellArb, { minLength: size * size, maxLength: size * size }).map((cells) => ({ size, cells })),
  );
const directionArb = fc.constantFrom(...DIRS);

function mass(board: Board): bigint {
  let total = 0n;
  for (const cell of board.cells) if (cell !== null) total += 1n << BigInt(cell);
  return total;
}

function mapCells(board: Board, source: (row: number, col: number) => number): Board {
  const { size } = board;
  const cells: Cell[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) cells.push(board.cells[source(row, col)] ?? null);
  }
  return { size, cells };
}

const transpose = (b: Board): Board => mapCells(b, (r, c) => c * b.size + r);
const mirror = (b: Board): Board => mapCells(b, (r, c) => r * b.size + (b.size - 1 - c));
/** 90 degrees clockwise: new[r][c] = old[n-1-c][r]. Old left edge becomes the top edge. */
const rotate = (b: Board): Board => mapCells(b, (r, c) => (b.size - 1 - c) * b.size + r);

describe("slide properties (ENG-08)", () => {
  it("conserves tile mass before spawn", () => {
    fc.assert(
      fc.property(boardArb, directionArb, (board, direction) => {
        expect(mass(slide(board, direction).board)).toBe(mass(board));
      }),
    );
  });

  it("scoreDelta equals the sum of merged values and each merge value is 2^exponent", () => {
    fc.assert(
      fc.property(boardArb, directionArb, (board, direction) => {
        const result = slide(board, direction);
        let sum = 0n;
        for (const event of result.events) {
          if (event.type !== "tile.merged") continue;
          expect(event.value).toBe((1n << BigInt(event.exponent)).toString());
          sum += BigInt(event.value);
        }
        expect(result.scoreDelta).toBe(sum.toString());
      }),
    );
  });

  it("is consistent under transpose, mirror and rotation", () => {
    fc.assert(
      fc.property(boardArb, (board) => {
        const left = slide(board, "left").board;
        const right = slide(board, "right").board;
        const up = slide(board, "up").board;
        const down = slide(board, "down").board;
        expect(slide(transpose(board), "up").board).toEqual(transpose(left));
        expect(slide(transpose(board), "left").board).toEqual(transpose(up));
        expect(slide(mirror(board), "right").board).toEqual(mirror(left));
        expect(slide(rotate(board), "up").board).toEqual(rotate(left));
        expect(slide(rotate(board), "right").board).toEqual(rotate(up));
        expect(slide(rotate(board), "down").board).toEqual(rotate(right));
        expect(slide(rotate(board), "left").board).toEqual(rotate(down));
        expect(slide(rotate(board), "up").scoreDelta).toBe(slide(board, "left").scoreDelta);
      }),
    );
  });

  it("a second identical slide is a no-op when nothing merged", () => {
    fc.assert(
      fc.property(boardArb, directionArb, (board, direction) => {
        const first = slide(board, direction);
        if (first.events.some((e) => e.type === "tile.merged")) return;
        const second = slide(first.board, direction);
        expect(second.changed).toBe(false);
        expect(second.board).toEqual(first.board);
        expect(second.events).toEqual([]);
      }),
    );
  });

  it("never mutates deep-frozen inputs and agrees with legalMoves", () => {
    fc.assert(
      fc.property(boardArb, (board) => {
        const frozen = deepFreeze(structuredClone(board));
        const snapshot = JSON.stringify(frozen);
        const legal = DIRS.filter((d) => slide(frozen, d).changed);
        expect(legalMoves(frozen)).toEqual(legal);
        expect(JSON.stringify(frozen)).toBe(snapshot);
      }),
    );
  });

  it("each tile participates in at most one merge and events reference real cells", () => {
    fc.assert(
      fc.property(boardArb, directionArb, (board, direction) => {
        const result = slide(board, direction);
        const used = new Set<number>();
        for (const event of result.events) {
          if (event.type === "tile.merged") {
            for (const source of event.sources) {
              expect(used.has(source)).toBe(false);
              used.add(source);
              expect(board.cells[source]).not.toBeNull();
            }
            expect(result.board.cells[event.to]).toBe(event.exponent);
          } else if (event.type === "tile.moved") {
            expect(board.cells[event.from]).toBe(event.exponent);
          }
        }
        expect(result.changed).toBe(result.events.length > 0);
      }),
    );
  });
});

const EVENT_RANK = {
  "tile.moved": 0,
  "tile.merged": 1,
  "tile.spawned": 2,
  "milestone.reached": 3,
  "game.over": 4,
};

function rulesFor(size: number, fourWeight: number): Ruleset {
  return size === 4 && fourWeight === 1
    ? RULESETS["classic-v1"]
    : practiceRuleset({ size, fourWeight, undo: true });
}

describe("applyMove properties (ENG-03, ENG-08)", () => {
  it("random games keep counters, score, mass and event invariants; inputs stay frozen", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 16 }),
        fc.integer({ min: 3, max: 8 }),
        fc.integer({ min: 0, max: 10 }),
        fc.array(directionArb, { minLength: 1, maxLength: 120 }),
        (seed, size, fourWeight, directions) => {
          const rules = rulesFor(size, fourWeight);
          let state: GameState = deepFreeze(newGame(rules, seed));
          for (const direction of directions) {
            if (state.status !== "active") break;
            const snapshot = JSON.stringify(state);
            const result = applyMove(state, direction, rules);
            expect(JSON.stringify(state)).toBe(snapshot);
            if (!result.changed) {
              expect(result.state).toBe(state);
              expect(result.events).toEqual([]);
              expect(result.scoreDelta).toBe("0");
              continue;
            }
            const next = result.state;
            expect(next.acceptedMoves).toBe(state.acceptedMoves + 1);
            expect(next.revision).toBe(state.revision + 1);
            expect(BigInt(next.score)).toBe(BigInt(state.score) + BigInt(result.scoreDelta));
            const spawns = result.events.filter((e) => e.type === "tile.spawned");
            expect(spawns).toHaveLength(1);
            const spawned = spawns[0]!;
            if (spawned.type === "tile.spawned") {
              expect(mass(next.board)).toBe(mass(state.board) + (1n << BigInt(spawned.exponent)));
              if (fourWeight === 0) expect(spawned.exponent).toBe("1");
              if (fourWeight === 10) expect(spawned.exponent).toBe("2");
            }
            const ranks = result.events.map((e) => EVENT_RANK[e.type]);
            expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
            expect(result.events.some((e) => e.type === "game.over")).toBe(isGameOver(next.board));
            expect(next.status).toBe(isGameOver(next.board) ? "completed" : "active");
            state = deepFreeze(next);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
