import { describe, expect, it } from "vitest";
import type { Board, Cell, Direction } from "@2048/contracts";
import { CLASSIC_RULES } from "@2048/contracts";
import { applyMove, createRng, legalMoves, newGame, slide } from "../src/index.ts";

const DIRS: Direction[] = ["up", "right", "down", "left"];

function randomBoard(rng: ReturnType<typeof createRng>, size: number, maxExp: number): Board {
  const cells: Cell[] = Array.from({ length: size * size }, () => {
    const v = rng.below(maxExp + 1);
    return v === 0 ? null : String(v);
  });
  return { size, cells };
}

const mass = (cells: readonly Cell[]) => cells.reduce<bigint>((a, c) => (c === null ? a : a + (1n << BigInt(c))), 0n);

function transpose(b: Board): Board {
  const { size } = b;
  const cells: Cell[] = new Array<Cell>(size * size).fill(null);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) cells[c * size + r] = b.cells[r * size + c] as Cell;
  return { size, cells };
}
function mirror(b: Board): Board {
  const { size } = b;
  const cells: Cell[] = new Array<Cell>(size * size).fill(null);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) cells[r * size + (size - 1 - c)] = b.cells[r * size + c] as Cell;
  return { size, cells };
}

describe("slide properties", () => {
  const rng = createRng([0xdeadbeef, 0x12345678, 0x9abcdef0, 0x0badf00d]);
  const cases: Board[] = [];
  for (let i = 0; i < 600; i++) cases.push(randomBoard(rng, 3 + (i % 6), 1 + (i % 7)));
  // include huge exponents so the property also covers values far past 2^53
  for (let i = 0; i < 100; i++) {
    const b = randomBoard(rng, 4, 3);
    cases.push({ size: 4, cells: b.cells.map((c) => (c === null ? null : (BigInt(c) + 5000n).toString())) });
  }

  it("conserves tile mass (sum of 2^e) and never increases tile count", () => {
    for (const b of cases) {
      for (const d of DIRS) {
        const r = slide(b, d);
        expect(mass(r.board.cells)).toBe(mass(b.cells));
        expect(r.board.cells.filter((c) => c !== null).length).toBeLessThanOrEqual(b.cells.filter((c) => c !== null).length);
      }
    }
  });

  it("score delta equals the sum of merged tile values and merge events agree", () => {
    for (const b of cases) {
      for (const d of DIRS) {
        const r = slide(b, d);
        const merges = r.events.flatMap((e) => (e.type === "merge" ? [e] : []));
        const sum = merges.reduce((a, e) => a + BigInt(e.value), 0n);
        expect(r.scoreDelta).toBe(sum.toString());
        for (const e of merges) {
          expect(BigInt(e.value)).toBe(1n << BigInt(e.exponent));
          expect(b.cells[e.sources[0]]).toBe(b.cells[e.sources[1]]);
          expect(BigInt(e.exponent)).toBe(BigInt(b.cells[e.sources[0]] as string) + 1n);
        }
        expect(r.changed).toBe(r.events.length > 0 || r.board.cells.some((c, i) => c !== b.cells[i]));
      }
    }
  });

  it("direction mirror and transpose are consistent", () => {
    for (const b of cases) {
      const left = slide(b, "left");
      const right = slide(b, "right");
      const up = slide(b, "up");
      const down = slide(b, "down");
      const viaMirror = mirror(slide(mirror(b), "left").board);
      expect(right.board.cells).toEqual(viaMirror.cells);
      expect(right.scoreDelta).toBe(slide(mirror(b), "left").scoreDelta);
      const viaT = transpose(slide(transpose(b), "left").board);
      expect(up.board.cells).toEqual(viaT.cells);
      expect(up.scoreDelta).toBe(slide(transpose(b), "left").scoreDelta);
      const viaTR = transpose(slide(transpose(b), "right").board);
      expect(down.board.cells).toEqual(viaTR.cells);
      expect(down.scoreDelta).toBe(slide(transpose(b), "right").scoreDelta);
      // after a left slide, sliding left again never merges unless equal tiles became adjacent (it can), but never loses mass
      expect(mass(slide(left.board, "left").board.cells)).toBe(mass(b.cells));
    }
  });

  it("no tile survives uncompressed: result rows are packed at the leading edge", () => {
    for (const b of cases) {
      const r = slide(b, "left");
      for (let row = 0; row < b.size; row++) {
        const line = r.board.cells.slice(row * b.size, (row + 1) * b.size);
        const firstNull = line.indexOf(null);
        if (firstNull >= 0) expect(line.slice(firstNull).every((c) => c === null)).toBe(true);
      }
    }
  });
});

describe("game-level properties", () => {
  it("random play keeps invariants: mass growth equals spawns, revision==acceptedMoves, legal-move agreement", () => {
    for (const seed of ["p1", "p2", "p3"]) {
      const rng = createRng([5, 6, 7, 8]);
      let s = newGame(CLASSIC_RULES, seed);
      let spawnedMass = mass(s.board.cells);
      let steps = 0;
      while (s.status === "active" && steps < 3000) {
        const dir = DIRS[rng.below(4)] as Direction;
        const legal = legalMoves(s.board);
        const r = applyMove(s, dir, CLASSIC_RULES);
        expect(r.changed).toBe(legal.includes(dir));
        if (r.changed) {
          const sp = r.events.find((e) => e.type === "spawn") as { exponent: string };
          spawnedMass += 1n << BigInt(sp.exponent);
          expect(r.state.revision).toBe(s.revision + 1);
          expect(r.state.acceptedMoves).toBe(s.acceptedMoves + 1);
          expect(BigInt(r.state.score) - BigInt(s.score)).toBe(BigInt(r.scoreDelta));
        } else {
          expect(r.state).toBe(s);
        }
        expect(mass(r.state.board.cells)).toBe(spawnedMass);
        s = r.state;
        steps++;
      }
      expect(steps).toBeGreaterThan(20);
    }
  });
});
