import type { Board, Cell } from "@2048/contracts";

/** Deterministic test-only generator (mulberry32). */
export function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBoard(rand: () => number, size: number, fill = 0.6, maxExp = 12): Board {
  const cells: Cell[] = [];
  for (let i = 0; i < size * size; i++) {
    cells.push(rand() < fill ? String(1 + Math.floor(rand() * maxExp)) : null);
  }
  return { size, cells };
}

export function boardOf(rows: (number | null)[][]): Board {
  return { size: rows.length, cells: rows.flat().map((v) => (v === null || v === 0 ? null : String(v))) };
}

/** A full 4x4 board with no legal move. */
export const DEAD_BOARD: Board = boardOf([
  [1, 2, 1, 2],
  [2, 1, 2, 1],
  [1, 2, 1, 2],
  [2, 1, 2, 1],
]);

export function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
