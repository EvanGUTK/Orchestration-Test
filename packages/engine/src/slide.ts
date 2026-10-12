import { DIRECTIONS, DomainError, MAX_BOARD_SIZE, MIN_BOARD_SIZE, MAX_EXPONENT_DIGITS } from "@2048/contracts";
import type { Board, Cell, Direction, DomainEvent, SlideResult } from "@2048/contracts";

/**
 * Largest exponent whose value (2^e) the engine will materialize as a decimal. A merge that would
 * produce a larger tile throws RESOURCE_LIMIT before any power is computed; the game is unchanged.
 */
export const MAX_MERGE_EXPONENT = 1_000_000;
const MAX_MERGE_EXPONENT_BIG = BigInt(MAX_MERGE_EXPONENT);
const MAX_CELLS = MAX_BOARD_SIZE * MAX_BOARD_SIZE;

export function isDirection(d: unknown): d is Direction {
  return d === "up" || d === "right" || d === "down" || d === "left";
}

// --- line tables --------------------------------------------------------------------------------
// lineTable[dir][size][line] = cell indexes ordered from the LEADING edge of `dir` backwards.
const lineTables = new Map<string, number[][]>();

function lines(size: number, dir: Direction): number[][] {
  const key = `${dir}:${size}`;
  let t = lineTables.get(key);
  if (t) return t;
  t = [];
  for (let a = 0; a < size; a++) {
    const line: number[] = [];
    for (let b = 0; b < size; b++) {
      const r = dir === "left" || dir === "right" ? a : dir === "up" ? b : size - 1 - b;
      const c = dir === "up" || dir === "down" ? a : dir === "left" ? b : size - 1 - b;
      line.push(r * size + c);
    }
    t.push(line);
  }
  lineTables.set(key, t);
  return t;
}

// --- exact arithmetic helpers (BigInt only; Number is limited to indexes/lengths) -----------------
const incCache = new Map<string, string>();
function incExponent(e: string): string {
  let r = incCache.get(e);
  if (r === undefined) {
    r = (BigInt(e) + 1n).toString();
    if (e.length <= 4) incCache.set(e, r);
  }
  return r;
}

const valueCache = new Map<string, { big: bigint; dec: string }>();
function tileValueOf(exponent: string): { big: bigint; dec: string } {
  const cached = valueCache.get(exponent);
  if (cached) return cached;
  if (exponent.length > MAX_EXPONENT_DIGITS || BigInt(exponent) > MAX_MERGE_EXPONENT_BIG) {
    throw new DomainError("RESOURCE_LIMIT", "merge would exceed the maximum supported tile exponent", {
      maxExponent: MAX_MERGE_EXPONENT,
    });
  }
  const big = 1n << BigInt(exponent);
  const v = { big, dec: big.toString() };
  if (exponent.length <= 3) valueCache.set(exponent, v);
  return v;
}

/** Larger of two canonical positive decimals without Number conversion. */
function maxCell(cells: readonly Cell[]): string {
  let best = "0";
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === null || c === undefined) continue;
    if (c.length > best.length || (c.length === best.length && c > best)) best = c;
  }
  return best;
}
export { maxCell as maxExponentOf };

// --- board shape check ---------------------------------------------------------------------------
const EXP_RE = /^[1-9][0-9]*$/;

export function assertBoard(board: unknown): asserts board is Board {
  const b = board as Board | null;
  if (typeof b !== "object" || b === null || !Array.isArray(b.cells)) {
    throw new DomainError("VALIDATION_ERROR", "board must be an object with a cells array");
  }
  const size = b.size;
  if (!Number.isInteger(size) || size < MIN_BOARD_SIZE || size > MAX_BOARD_SIZE) {
    throw new DomainError("VALIDATION_ERROR", "board size must be an integer from 3 to 8");
  }
  if (b.cells.length !== size * size) {
    throw new DomainError("VALIDATION_ERROR", "board must have size*size cells");
  }
  for (let i = 0; i < b.cells.length; i++) assertCell(b.cells[i], i);
}

export function assertCell(c: unknown, index: number): void {
  if (c === null) return;
  if (typeof c !== "string") {
    throw new DomainError("VALIDATION_ERROR", `cell ${index} must be null or an exponent string`);
  }
  if (c.length <= MAX_EXPONENT_DIGITS) {
    if (!EXP_RE.test(c)) throw new DomainError("VALIDATION_ERROR", `cell ${index} is not a canonical exponent`);
    return;
  }
  if (c.length > 4_000_000 || EXP_RE.test(c)) {
    throw new DomainError("RESOURCE_LIMIT", `cell ${index} exponent exceeds ${MAX_EXPONENT_DIGITS} digits`);
  }
  throw new DomainError("VALIDATION_ERROR", `cell ${index} is not a canonical exponent`);
}

// --- slide core ----------------------------------------------------------------------------------
// Scratch (sync, non-reentrant): for each destination cell, the source cell(s) that produced it.
const srcA = new Int32Array(MAX_CELLS);
const srcB = new Int32Array(MAX_CELLS);

export type SlideCore = { next: Cell[]; changed: boolean; delta: bigint; merges: number };

/** Randomness-free slide on already-validated cells. Fills the module scratch for `slideEvents`. */
export function slideCore(cells: readonly Cell[], size: number, dir: Direction): SlideCore {
  const n = size * size;
  const next: Cell[] = new Array<Cell>(n).fill(null);
  srcA.fill(-1, 0, n);
  srcB.fill(-1, 0, n);
  let changed = false;
  let delta = 0n;
  let merges = 0;
  const table = lines(size, dir);
  for (let li = 0; li < size; li++) {
    const idx = table[li] as number[];
    let k = 0; // outputs placed in this line
    let lastSrc = -1; // source index of output k-1 while it may still merge
    let lastVal: Cell = null;
    for (let j = 0; j < size; j++) {
      const i = idx[j] as number;
      const c = cells[i] as Cell;
      if (c === null) continue;
      if (lastSrc >= 0 && lastVal === c) {
        const dest = idx[k - 1] as number;
        const merged = incExponent(c);
        delta += tileValueOf(merged).big;
        next[dest] = merged;
        srcB[dest] = i;
        lastSrc = -1;
        lastVal = null;
        changed = true;
        merges++;
      } else {
        const dest = idx[k] as number;
        next[dest] = c;
        srcA[dest] = i;
        if (dest !== i) changed = true;
        lastSrc = i;
        lastVal = c;
        k++;
      }
    }
  }
  return { next, changed, delta, merges };
}

/** Builds `move` then `merge` events from the scratch left by the immediately preceding `slideCore`. */
export function slideEvents(cells: readonly Cell[], next: readonly Cell[], size: number): DomainEvent[] {
  const n = size * size;
  const events: DomainEvent[] = [];
  for (let d = 0; d < n; d++) {
    if (next[d] === null) continue;
    const a = srcA[d] as number;
    if (a !== d) events.push({ type: "move", from: a, to: d, exponent: cells[a] as string });
    const b = srcB[d] as number;
    if (b >= 0) events.push({ type: "move", from: b, to: d, exponent: cells[b] as string });
  }
  for (let d = 0; d < n; d++) {
    const b = srcB[d] as number;
    if (b < 0) continue;
    const exponent = next[d] as string;
    events.push({ type: "merge", sources: [srcA[d] as number, b], to: d, exponent, value: tileValueOf(exponent).dec });
  }
  return events;
}

export function slide(board: Board, direction: Direction): SlideResult {
  assertBoard(board);
  if (!isDirection(direction)) throw new DomainError("VALIDATION_ERROR", "invalid direction");
  const core = slideCore(board.cells, board.size, direction);
  if (!core.changed) return { board, changed: false, scoreDelta: "0", events: [] };
  return {
    board: { size: board.size, cells: core.next },
    changed: true,
    scoreDelta: core.delta.toString(),
    events: slideEvents(board.cells, core.next, board.size),
  };
}

// --- legality ------------------------------------------------------------------------------------
/** True when some tile can move or merge toward `dir` (no allocation). */
export function canMove(cells: readonly Cell[], size: number, dir: Direction): boolean {
  const dr = dir === "up" ? -1 : dir === "down" ? 1 : 0;
  const dc = dir === "left" ? -1 : dir === "right" ? 1 : 0;
  for (let r = 0; r < size; r++) {
    const nr = r + dr;
    if (nr < 0 || nr >= size) continue;
    for (let c = 0; c < size; c++) {
      const nc = c + dc;
      if (nc < 0 || nc >= size) continue;
      const here = cells[r * size + c] as Cell;
      if (here === null) continue;
      const there = cells[nr * size + nc] as Cell;
      if (there === null || there === here) return true;
    }
  }
  return false;
}

export function legalMovesOf(cells: readonly Cell[], size: number): Direction[] {
  return DIRECTIONS.filter((d) => canMove(cells, size, d));
}

export function legalMoves(board: Board): Direction[] {
  assertBoard(board);
  return legalMovesOf(board.cells, board.size);
}

export function isDeadBoard(cells: readonly Cell[], size: number): boolean {
  for (let i = 0; i < cells.length; i++) if (cells[i] === null) return false;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = cells[r * size + c];
      if (c + 1 < size && cells[r * size + c + 1] === v) return false;
      if (r + 1 < size && cells[(r + 1) * size + c] === v) return false;
    }
  }
  return true;
}

export function isGameOver(board: Board): boolean {
  assertBoard(board);
  return isDeadBoard(board.cells, board.size);
}
