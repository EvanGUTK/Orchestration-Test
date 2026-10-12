import { DIRECTIONS, DomainError, MAX_EXPONENT_DIGITS, MAX_BOARD_SIZE, MIN_BOARD_SIZE, isExponent } from "@2048/contracts";
import type { Board, Direction } from "@2048/contracts";

/**
 * Allocation-light board simulation used ONLY for bot search. Cells are tile EXPONENTS as small integers
 * (0 = empty). Exponents are bounded by the engine's MAX_EXPONENT_DIGITS guard, so Number is exact here;
 * tile values and scores never pass through Number. Semantics mirror the engine's `slide` (verified against
 * it in tests): compress toward the leading edge, merge adjacent equals once each.
 */
export type Grid = Int32Array;

export type SlideStats = {
  /** Exponents produced by merges in this slide (new exponent of each merged tile). */
  merged: Int32Array;
  mergedCount: number;
};

export function newStats(n: number): SlideStats {
  return { merged: new Int32Array(n * n), mergedCount: 0 };
}

/** Direction index 0..3 follows DIRECTIONS (up,right,down,left). */
const tables = new Map<number, Int32Array[]>();
function lineTables(n: number): Int32Array[] {
  let t = tables.get(n);
  if (t) return t;
  t = DIRECTIONS.map((dir) => {
    const idx = new Int32Array(n * n);
    for (let line = 0; line < n; line++) {
      for (let pos = 0; pos < n; pos++) {
        let cell: number;
        switch (dir) {
          case "left": cell = line * n + pos; break;
          case "right": cell = line * n + (n - 1 - pos); break;
          case "up": cell = pos * n + line; break;
          default: cell = (n - 1 - pos) * n + line; break; // down
        }
        idx[line * n + pos] = cell;
      }
    }
    return idx;
  });
  tables.set(n, t);
  return t;
}

/** Defensive copy of a board into exponent integers. Throws on malformed boards / exponents beyond the engine guard. */
export function toGrid(board: Board): { grid: Grid; n: number } {
  const n = board.size;
  if (!Number.isInteger(n) || n < MIN_BOARD_SIZE || n > MAX_BOARD_SIZE || board.cells.length !== n * n) {
    throw new DomainError("VALIDATION_ERROR", "invalid board");
  }
  const grid = new Int32Array(n * n);
  for (let i = 0; i < grid.length; i++) {
    const c = board.cells[i];
    if (c === null || c === undefined) continue;
    if (!isExponent(c) || c.length > MAX_EXPONENT_DIGITS) throw new DomainError("RESOURCE_LIMIT", "tile exponent beyond bot search limits");
    const e = Number(c);
    if (e > 0x7fffffff) throw new DomainError("RESOURCE_LIMIT", "tile exponent beyond bot search limits");
    grid[i] = e;
  }
  return { grid, n };
}

/** Slide `src` into `dst`; returns whether anything moved or merged. `stats` is reset and filled. */
export function slide(src: Grid, dst: Grid, n: number, dirIndex: number, stats: SlideStats): boolean {
  const idx = lineTables(n)[dirIndex]!;
  stats.mergedCount = 0;
  let changed = false;
  for (let line = 0; line < n; line++) {
    const base = line * n;
    let w = 0;
    let pending = 0;
    for (let pos = 0; pos < n; pos++) {
      const v = src[idx[base + pos]!]!;
      if (v === 0) continue;
      if (pending === v) {
        const m = v + 1;
        dst[idx[base + w]!] = m;
        w++;
        stats.merged[stats.mergedCount++] = m;
        pending = 0;
      } else {
        if (pending !== 0) {
          dst[idx[base + w]!] = pending;
          w++;
        }
        pending = v;
      }
    }
    if (pending !== 0) {
      dst[idx[base + w]!] = pending;
      w++;
    }
    for (; w < n; w++) dst[idx[base + w]!] = 0;
    for (let pos = 0; pos < n; pos++) {
      const c = idx[base + pos]!;
      if (src[c] !== dst[c]) changed = true;
    }
  }
  return changed;
}

export function emptyCount(grid: Grid): number {
  let e = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === 0) e++;
  return e;
}

/** Directions (in engine order up,right,down,left) whose slide changes the board. */
export function legalDirectionIndexes(grid: Grid, n: number): number[] {
  const scratch: Grid = new Int32Array(grid.length);
  const stats = newStats(n);
  const out: number[] = [];
  for (let d = 0; d < 4; d++) if (slide(grid, scratch, n, d, stats)) out.push(d);
  return out;
}

export function directionAt(index: number): Direction {
  return DIRECTIONS[index]!;
}
