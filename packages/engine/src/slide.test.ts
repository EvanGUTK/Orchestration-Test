import { readFileSync } from "node:fs";
import type { Board, Cell, Direction, DomainEvent } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.js";
import { isGameOver, legalMoves, maxExponent, slide } from "./slide.js";

type SlideVector = {
  id: string;
  size: number;
  direction: Direction;
  before: Cell[];
  after: Cell[];
  scoreDelta: string;
  changed: boolean;
};

function readJson<T>(relative: string): T {
  const text = readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  return JSON.parse(text) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function board(size: number, cells: (string | null)[]): Board {
  return deepFreeze({ size, cells });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof EngineError ? error.code : "RAW";
  }
}

const fixtures = readJson<{ vectors: SlideVector[] }>("../../../tests/fixtures/slide-v1.json");

describe("slide-v1 public fixtures (ENG-01, ENG-02)", () => {
  it("has all 11 vectors", () => {
    expect(fixtures.vectors).toHaveLength(11);
  });

  for (const vector of fixtures.vectors) {
    it(vector.id, () => {
      const input = board(vector.size, [...vector.before]);
      const snapshot = JSON.stringify(input);
      const result = slide(input, vector.direction);
      expect(result.board.cells).toEqual(vector.after);
      expect(result.board.size).toBe(vector.size);
      expect(result.scoreDelta).toBe(vector.scoreDelta);
      expect(result.changed).toBe(vector.changed);
      expect(JSON.stringify(input)).toBe(snapshot);
      if (!vector.changed) expect(result.events).toEqual([]);
    });
  }
});

describe("slide semantics", () => {
  const E = null;

  it("handles all four directions on a full alternating board (no change)", () => {
    const cells = Array.from({ length: 16 }, (_, i) => ((Math.floor(i / 4) + i) % 2 === 0 ? "1" : "2"));
    const input = board(4, cells);
    for (const direction of ["up", "right", "down", "left"] as const) {
      const result = slide(input, direction);
      expect(result.changed).toBe(false);
      expect(result.board.cells).toEqual(cells);
      expect(result.scoreDelta).toBe("0");
    }
    expect(isGameOver(input)).toBe(true);
    expect(legalMoves(input)).toEqual([]);
  });

  it("merges each column independently going down", () => {
    const input = board(4, ["1", "2", E, "3", "1", "2", E, "3", "1", E, E, "3", "1", "2", E, "3"]);
    const result = slide(input, "down");
    expect(result.board.cells).toEqual([E, E, E, E, E, E, E, E, "2", "2", E, "4", "2", "3", E, "4"]);
    expect(result.scoreDelta).toBe(String(4 + 4 + 8 + 16 + 16));
  });

  it("works on 3x3 and 8x8 boards", () => {
    const three = board(3, ["1", "1", "1", E, E, E, "2", E, "2"]);
    expect(slide(three, "right").board.cells).toEqual([E, "1", "2", E, E, E, E, E, "3"]);
    const cells: Cell[] = new Array<Cell>(64).fill(null);
    cells[56] = "5";
    cells[63] = "5";
    const eight = slide(board(8, cells), "left");
    expect(eight.board.cells[56]).toBe("6");
    expect(eight.board.cells.filter((c) => c !== null)).toEqual(["6"]);
    expect(eight.scoreDelta).toBe("64");
  });

  it("emits tile.moved sorted by destination then source, then tile.merged by destination", () => {
    // Row 0: [1,1,1,1] -> [2,2,_,_]; row 1: [_,3,_,3] -> [4,_,_,_]
    const input = board(4, ["1", "1", "1", "1", E, "3", E, "3", E, E, E, E, E, E, E, E]);
    const result = slide(input, "left");
    const expected: DomainEvent[] = [
      { type: "tile.moved", from: 1, to: 0, exponent: "1" },
      { type: "tile.moved", from: 2, to: 1, exponent: "1" },
      { type: "tile.moved", from: 3, to: 1, exponent: "1" },
      { type: "tile.moved", from: 5, to: 4, exponent: "3" },
      { type: "tile.moved", from: 7, to: 4, exponent: "3" },
      { type: "tile.merged", to: 0, sources: [0, 1], exponent: "2", value: "4" },
      { type: "tile.merged", to: 1, sources: [2, 3], exponent: "2", value: "4" },
      { type: "tile.merged", to: 4, sources: [5, 7], exponent: "4", value: "16" },
    ];
    expect(result.events).toEqual(expected);
    expect(result.scoreDelta).toBe("24");
  });

  it("orders events by destination index when sliding up/right (lines processed out of row-major order)", () => {
    // Column 0: rows 1,3 hold "2" -> merge at 0. Column 2: row 3 "1" moves to 2. Row-major destinations: 0, 2.
    const input = board(4, [E, E, E, E, "2", E, E, E, E, E, E, E, "2", E, "1", E]);
    const result = slide(input, "up");
    expect(result.events).toEqual([
      { type: "tile.moved", from: 4, to: 0, exponent: "2" },
      { type: "tile.moved", from: 12, to: 0, exponent: "2" },
      { type: "tile.moved", from: 14, to: 2, exponent: "1" },
      { type: "tile.merged", to: 0, sources: [4, 12], exponent: "3", value: "8" },
    ]);
    const right = slide(board(4, ["1", E, "1", E, E, E, E, E, "2", E, E, E, E, E, E, E]), "right");
    expect(right.events).toEqual([
      { type: "tile.moved", from: 0, to: 3, exponent: "1" },
      { type: "tile.moved", from: 2, to: 3, exponent: "1" },
      { type: "tile.moved", from: 8, to: 11, exponent: "2" },
      { type: "tile.merged", to: 3, sources: [2, 0], exponent: "2", value: "4" },
    ]);
  });

  it("does not emit tile.moved for a merge source already at its destination", () => {
    const result = slide(board(4, ["1", "1", E, E, E, E, E, E, E, E, E, E, E, E, E, E]), "left");
    expect(result.events).toEqual([
      { type: "tile.moved", from: 1, to: 0, exponent: "1" },
      { type: "tile.merged", to: 0, sources: [0, 1], exponent: "2", value: "4" },
    ]);
  });

  it("throws RESOURCE_LIMIT when a merge would exceed LIMITS.maxExponent and keeps the input", () => {
    const input = board(4, ["1000000", "1000000", E, E, E, E, E, E, E, E, E, E, E, E, E, E]);
    const snapshot = JSON.stringify(input);
    expect(codeOf(() => slide(input, "left"))).toBe("RESOURCE_LIMIT");
    expect(JSON.stringify(input)).toBe(snapshot);
    // Sliding without merging the max tile is fine.
    expect(slide(input, "down").changed).toBe(true);
    expect(
      slide(board(4, ["999999", "999999", ...new Array<null>(14).fill(null)]), "left").board.cells[0],
    ).toBe("1000000");
  });

  it("rejects malformed boards and directions with VALIDATION_ERROR", () => {
    const ok = board(4, new Array<null>(16).fill(null));
    expect(codeOf(() => slide(ok, "diagonal" as Direction))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => slide({ size: 2, cells: [E, E, E, E] }, "up"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => slide({ size: 9, cells: new Array<null>(81).fill(null) }, "up"))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codeOf(() => slide({ size: 4.5, cells: [] }, "up"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => slide({ size: 4, cells: new Array<null>(15).fill(null) }, "up"))).toBe(
      "VALIDATION_ERROR",
    );
    for (const bad of ["0", "01", "-1", "1.5", "", 1, 2.5]) {
      const cells = new Array<unknown>(16).fill(null);
      cells[3] = bad;
      expect(codeOf(() => slide({ size: 4, cells } as unknown as Board, "up"))).toBe("VALIDATION_ERROR");
    }
    expect(codeOf(() => slide(null as unknown as Board, "up"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => legalMoves({ size: 4, cells: "x" } as unknown as Board))).toBe("VALIDATION_ERROR");
  });
});

describe("legalMoves / isGameOver / maxExponent (ENG-07)", () => {
  const E = null;

  it("lists legal moves in stable order", () => {
    expect(legalMoves(board(4, ["1", ...new Array<null>(15).fill(null)]))).toEqual(["right", "down"]);
    expect(legalMoves(board(4, new Array<null>(16).fill(null)))).toEqual([]);
    const middle = new Array<Cell>(16).fill(null);
    middle[5] = "3";
    expect(legalMoves(board(4, middle))).toEqual(["up", "right", "down", "left"]);
  });

  it("legalMoves agrees with slide().changed", () => {
    const input = board(4, ["1", "2", "3", "4", "2", "3", "4", "5", "1", "2", "3", "4", "2", "3", "5", "5"]);
    const expected = (["up", "right", "down", "left"] as const).filter((d) => slide(input, d).changed);
    expect(legalMoves(input)).toEqual(expected);
    expect(expected).toEqual(["right", "left"]);
  });

  it("full unequal board is dead; full mergeable board is alive", () => {
    const dead = board(4, ["1", "2", "1", "2", "2", "1", "2", "1", "1", "2", "1", "2", "2", "1", "2", "1"]);
    expect(isGameOver(dead)).toBe(true);
    const vertical = board(4, [
      "1",
      "2",
      "1",
      "2",
      "2",
      "1",
      "2",
      "1",
      "1",
      "2",
      "1",
      "2",
      "1",
      "3",
      "4",
      "5",
    ]);
    expect(isGameOver(vertical)).toBe(false);
    expect(legalMoves(vertical)).toEqual(["up", "down"]);
    expect(isGameOver(board(4, [E, ...dead.cells.slice(1)]))).toBe(false);
  });

  it("finds the maximum exponent exactly", () => {
    expect(maxExponent(board(4, new Array<null>(16).fill(null)))).toBeNull();
    const cells: Cell[] = new Array<Cell>(16).fill(null);
    cells[2] = "9";
    cells[7] = "4096";
    cells[9] = "54";
    cells[15] = "1000";
    expect(maxExponent(board(4, cells))).toBe("4096");
  });
});
