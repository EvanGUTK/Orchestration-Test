import { DIRECTIONS, MAX_BOARD_SIZE, MIN_BOARD_SIZE } from "@g2048/contracts";
import type { Board, Cell, Direction, DomainEvent, Exponent, SlideResult } from "@g2048/contracts";
import { compareCanonical, isExponent, nextExponent, pow2Canonical } from "./decimal.js";
import { invalid } from "./errors.js";

type MovedEvent = Extract<DomainEvent, { type: "tile.moved" }>;
type MergedEvent = Extract<DomainEvent, { type: "tile.merged" }>;

export function isDirection(value: unknown): value is Direction {
  return value === "up" || value === "right" || value === "down" || value === "left";
}

export function requireDirection(value: unknown): asserts value is Direction {
  if (!isDirection(value)) throw invalid("direction must be one of up, right, down, left");
}

/**
 * Validates a board's shape: integer size in [MIN_BOARD_SIZE, MAX_BOARD_SIZE], a cells array of
 * exactly size*size entries, each null or a canonical exponent string. Throws VALIDATION_ERROR.
 */
export function validateBoard(board: unknown): asserts board is Board {
  if (typeof board !== "object" || board === null) throw invalid("board must be an object");
  const { size, cells } = board as { size?: unknown; cells?: unknown };
  if (typeof size !== "number" || !Number.isInteger(size) || size < MIN_BOARD_SIZE || size > MAX_BOARD_SIZE) {
    throw invalid(`board.size must be an integer in ${MIN_BOARD_SIZE}..${MAX_BOARD_SIZE}`);
  }
  if (!Array.isArray(cells) || cells.length !== size * size) {
    throw invalid("board.cells must be an array of length size*size");
  }
  for (let i = 0; i < cells.length; i += 1) {
    const cell: unknown = cells[i];
    if (cell !== null && !isExponent(cell)) {
      throw invalid(`board.cells[${i}] must be null or a canonical exponent string`);
    }
  }
}

/** Start index and stride of line `line` walked from the edge tiles move toward. */
function lineGeometry(size: number, direction: Direction, line: number): [number, number] {
  switch (direction) {
    case "left":
      return [line * size, 1];
    case "right":
      return [line * size + size - 1, -1];
    case "up":
      return [line, size];
    case "down":
      return [(size - 1) * size + line, -size];
  }
}

function byDestinationThenSource(a: MovedEvent, b: MovedEvent): number {
  return a.to - b.to || a.from - b.from;
}

function byDestination(a: MergedEvent, b: MergedEvent): number {
  return a.to - b.to;
}

/**
 * Slide/merge core on a validated board. Each line is compressed toward the leading edge and equal
 * neighbours merge from the leading edge; a tile participates in at most one merge per move.
 * RESOURCE_LIMIT is thrown (before any power is computed) if a merge would exceed LIMITS.maxExponent.
 */
export function slideCells(size: number, cells: readonly Cell[], direction: Direction): SlideResult {
  const out: Cell[] = new Array<Cell>(cells.length).fill(null);
  const moved: MovedEvent[] = [];
  const merged: MergedEvent[] = [];
  let firstValue: string | null = null;
  let total: bigint | null = null;

  for (let line = 0; line < size; line += 1) {
    const [start, stride] = lineGeometry(size, direction, line);
    let write = start;
    let pendingExp: string | null = null;
    let pendingSrc = -1;
    for (let k = 0, src = start; k < size; k += 1, src += stride) {
      const exp = cells[src] ?? null;
      if (exp === null) continue;
      if (pendingExp === null) {
        pendingExp = exp;
        pendingSrc = src;
        continue;
      }
      if (pendingExp === exp) {
        const result = nextExponent(exp);
        const value = pow2Canonical(result);
        out[write] = result;
        if (pendingSrc !== write)
          moved.push({ type: "tile.moved", from: pendingSrc, to: write, exponent: exp });
        moved.push({ type: "tile.moved", from: src, to: write, exponent: exp });
        merged.push({ type: "tile.merged", to: write, sources: [pendingSrc, src], exponent: result, value });
        if (firstValue === null) firstValue = value;
        else total = (total ?? BigInt(firstValue)) + BigInt(value);
        pendingExp = null;
      } else {
        out[write] = pendingExp;
        if (pendingSrc !== write) {
          moved.push({ type: "tile.moved", from: pendingSrc, to: write, exponent: pendingExp });
        }
        pendingExp = exp;
        pendingSrc = src;
      }
      write += stride;
    }
    if (pendingExp !== null) {
      out[write] = pendingExp;
      if (pendingSrc !== write)
        moved.push({ type: "tile.moved", from: pendingSrc, to: write, exponent: pendingExp });
    }
  }

  const changed = moved.length > 0;
  if (!changed) return { board: { size, cells: out }, changed: false, scoreDelta: "0", events: [] };
  if (moved.length > 1) moved.sort(byDestinationThenSource);
  if (merged.length > 1) merged.sort(byDestination);
  const scoreDelta = total !== null ? total.toString() : (firstValue ?? "0");
  const events: DomainEvent[] = moved;
  for (const event of merged) events.push(event);
  return { board: { size, cells: out }, changed, scoreDelta, events };
}

/**
 * Pure slide without randomness. Returns the new board, `changed`, the exact score delta (sum of
 * merged tile values) and tile.moved events (sorted by destination, then source) followed by
 * tile.merged events (sorted by destination). Merge `sources` are [leading tile, trailing tile]
 * in the direction of motion. The input board is never mutated.
 */
export function slide(board: Board, direction: Direction): SlideResult {
  validateBoard(board);
  requireDirection(direction);
  return slideCells(board.size, board.cells, direction);
}

/** True if sliding the validated cells in `direction` would change the board. */
export function canMove(size: number, cells: readonly Cell[], direction: Direction): boolean {
  for (let line = 0; line < size; line += 1) {
    const [start, stride] = lineGeometry(size, direction, line);
    let sawEmpty = false;
    let prev: Cell = null;
    for (let k = 0, src = start; k < size; k += 1, src += stride) {
      const exp = cells[src] ?? null;
      if (exp === null) {
        sawEmpty = true;
        continue;
      }
      if (sawEmpty || prev === exp) return true;
      prev = exp;
    }
  }
  return false;
}

/** Directions that change the board, in stable order up, right, down, left. */
export function legalMoves(board: Board): Direction[] {
  validateBoard(board);
  return DIRECTIONS.filter((direction) => canMove(board.size, board.cells, direction));
}

/** Dead-board test on validated cells: no empty cell and no orthogonally adjacent equal exponents. */
export function isDead(size: number, cells: readonly Cell[]): boolean {
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const index = row * size + col;
      const exp = cells[index] ?? null;
      if (exp === null) return false;
      if (col + 1 < size && cells[index + 1] === exp) return false;
      if (row + 1 < size && cells[index + size] === exp) return false;
    }
  }
  return true;
}

/** True when the board has no empty cell and no adjacent equal exponents. */
export function isGameOver(board: Board): boolean {
  validateBoard(board);
  return isDead(board.size, board.cells);
}

/** Largest exponent of validated cells, or null for an empty board. */
export function maxExponentOf(cells: readonly Cell[]): Exponent | null {
  let max: string | null = null;
  for (const exp of cells) {
    if (exp !== null && (max === null || compareCanonical(exp, max) > 0)) max = exp;
  }
  return max;
}

/** Largest exponent on the board, or null when the board is empty. */
export function maxExponent(board: Board): Exponent | null {
  validateBoard(board);
  return maxExponentOf(board.cells);
}
