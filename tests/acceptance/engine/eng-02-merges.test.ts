// ENG-02 | Triple/quadruple merges and collisions
// Pass evidence: one merge per tile; public slide vectors pass.
import { describe, expect, it } from "vitest";
import type { Board, Cell, DomainEvent } from "@g2048/contracts";
import { E } from "./engine-api.js";
import { ROTATE_CW_DIRECTION, SLIDE_FIXTURE, frozen, rotateCw, rows } from "./helpers.js";

function line(cells: Cell[]): Board {
  // A single-row probe embedded in an otherwise empty board of matching size.
  const n = cells.length;
  return { size: n, cells: [...cells, ...Array<Cell>(n * n - n).fill(null)] };
}

describe("ENG-02 triple/quadruple merges and collisions", () => {
  describe("public tests/fixtures/slide-v1.json (all 11 vectors)", () => {
    it("fixture has 11 vectors", () => expect(SLIDE_FIXTURE.vectors).toHaveLength(11));
    for (const v of SLIDE_FIXTURE.vectors) {
      it(`${v.id}`, () => {
        const input = frozen({ size: v.size, cells: v.before });
        const res = E.slide(input, v.direction);
        expect(res.board.cells).toEqual(v.after);
        expect(res.board.size).toBe(v.size);
        expect(res.scoreDelta).toBe(v.scoreDelta);
        expect(res.changed).toBe(v.changed);
      });
      it(`${v.id} holds under all four board rotations`, () => {
        let b: Board = { size: v.size, cells: v.before };
        let after: Board = { size: v.size, cells: v.after };
        let d = v.direction;
        for (let k = 0; k < 4; k++) {
          const res = E.slide(frozen(b), d);
          expect(res.board).toEqual(after);
          expect(res.scoreDelta).toBe(v.scoreDelta);
          b = rotateCw(b);
          after = rotateCw(after);
          d = ROTATE_CW_DIRECTION[d];
        }
      });
    }
  });

  const collisions: { name: string; before: Cell[]; after: Cell[]; delta: string }[] = [
    {
      name: "[2,2,2,2] -> [4,4] not [8]",
      before: ["1", "1", "1", "1"],
      after: ["2", "2", null, null],
      delta: "8",
    },
    {
      name: "[2,2,2] merges leading pair",
      before: ["1", "1", "1", null],
      after: ["2", "1", null, null],
      delta: "4",
    },
    {
      name: "[4,2,2] merged 4 does not re-merge",
      before: ["2", "1", "1", null],
      after: ["2", "2", null, null],
      delta: "4",
    },
    {
      name: "[2,2,4,4] two independent merges",
      before: ["1", "1", "2", "2"],
      after: ["2", "3", null, null],
      delta: "12",
    },
    { name: "[4,4,2,2]", before: ["2", "2", "1", "1"], after: ["3", "2", null, null], delta: "12" },
    {
      name: "[2,_,_,2] compress then merge",
      before: ["1", null, null, "1"],
      after: ["2", null, null, null],
      delta: "4",
    },
    {
      name: "[2,4,2,4] no merges, no change",
      before: ["1", "2", "1", "2"],
      after: ["1", "2", "1", "2"],
      delta: "0",
    },
    { name: "[8,4,4,_]", before: ["3", "2", "2", null], after: ["3", "3", null, null], delta: "8" },
    {
      name: "5-wide [2,2,2,2,2] -> [4,4,2]",
      before: ["1", "1", "1", "1", "1"],
      after: ["2", "2", "1", null, null],
      delta: "8",
    },
    {
      name: "8-wide six equal + two equal",
      before: ["1", "1", "1", "1", "1", "1", "4", "4"],
      after: ["2", "2", "2", "5", null, null, null, null],
      delta: "44",
    },
  ];
  for (const c of collisions) {
    it(`collision: ${c.name}`, () => {
      const res = E.slide(frozen(line(c.before)), "left");
      expect(res.board.cells.slice(0, c.before.length)).toEqual(c.after);
      expect(res.scoreDelta).toBe(c.delta);
    });
  }

  it("each tile participates in at most one merge (merged sources are disjoint)", () => {
    const res = E.slide(frozen(rows("1 1 1 1", "2 1 1 .", "1 1 2 2", "3 3 3 3")), "left");
    const merged = res.events.filter(
      (e): e is Extract<DomainEvent, { type: "tile.merged" }> => e.type === "tile.merged",
    );
    const sources = merged.flatMap((m) => [...m.sources]);
    expect(new Set(sources).size).toBe(sources.length);
    expect(merged).toHaveLength(2 + 1 + 2 + 2);
  });

  it("quad-left emits moved then merged events in destination row-major order", () => {
    const res = E.slide(frozen(rows("1 1 1 1", ". . . .", ". . . .", ". . . .")), "left");
    const moved = res.events.filter((e) => e.type === "tile.moved");
    const merged = res.events.filter((e) => e.type === "tile.merged");
    // every moved event precedes every merged event
    const lastMoved = res.events.findLastIndex((e) => e.type === "tile.moved");
    const firstMerged = res.events.findIndex((e) => e.type === "tile.merged");
    expect(lastMoved).toBeLessThan(firstMerged);
    expect(res.events.every((e) => e.type === "tile.moved" || e.type === "tile.merged")).toBe(true);
    // sources that change position: 1->0, 2->1, 3->1 (sorted by destination, then source)
    expect(moved).toEqual([
      { type: "tile.moved", from: 1, to: 0, exponent: "1" },
      { type: "tile.moved", from: 2, to: 1, exponent: "1" },
      { type: "tile.moved", from: 3, to: 1, exponent: "1" },
    ]);
    expect(
      merged.map((m) => (m.type === "tile.merged" ? { ...m, sources: [...m.sources].sort() } : m)),
    ).toEqual([
      { type: "tile.merged", to: 0, sources: [0, 1], exponent: "2", value: "4" },
      { type: "tile.merged", to: 1, sources: [2, 3], exponent: "2", value: "4" },
    ]);
  });
});
