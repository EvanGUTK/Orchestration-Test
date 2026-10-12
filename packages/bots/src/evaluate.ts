import type { Board, Cell, Exponent } from "@g2048/contracts";

/**
 * Static board evaluation shared by heuristic-v1 and expectimax-v1 (version EVAL_VERSION).
 * Works on exponents only (tile 2^e is represented by e, empty by 0), all integer
 * arithmetic, so the value is exact and identical on every platform:
 *
 *   value = W_EMPTY * empties
 *         - W_MONOTONICITY * monotonicityPenalty
 *         - W_SMOOTHNESS * smoothnessPenalty
 *         + W_CORNER * cornerBonus
 *
 *  - empties: number of empty cells (room to manoeuvre).
 *  - monotonicityPenalty: for every row and column, the smaller of the "should be
 *    non-increasing" and "should be non-decreasing" violation sums (sum of exponent rises),
 *    so lines that are sorted in either direction cost 0.
 *  - smoothnessPenalty: sum of |e1 - e2| over horizontally/vertically adjacent non-empty
 *    pairs (equal neighbours are merge-ready).
 *  - cornerBonus: the max exponent when a corner holds the max tile, else 0.
 */
export const EVAL_VERSION = "eval-v1";
export const EVAL_WEIGHTS = { empty: 270, monotonicity: 47, smoothness: 11, corner: 100 } as const;
/** Value of a board with no legal move; below any reachable evaluation. */
export const DEAD_BOARD_VALUE = -1_000_000_000;

export function exponentOf(cell: Cell): number {
  return cell === null ? 0 : Number(cell);
}

export function toExponents(board: Board): number[] {
  return board.cells.map(exponentOf);
}

export function evaluateBoard(board: Board): number {
  return evaluateExponents(toExponents(board), board.size);
}

export function evaluateExponents(e: readonly number[], size: number): number {
  let empties = 0;
  let smooth = 0;
  let mono = 0;
  let max = 0;
  for (let i = 0; i < e.length; i += 1) {
    const v = e[i] as number;
    if (v === 0) empties += 1;
    if (v > max) max = v;
  }
  for (let line = 0; line < size; line += 1) {
    let rowUp = 0;
    let rowDown = 0;
    let colUp = 0;
    let colDown = 0;
    for (let k = 0; k + 1 < size; k += 1) {
      const r1 = e[line * size + k] as number;
      const r2 = e[line * size + k + 1] as number;
      const c1 = e[k * size + line] as number;
      const c2 = e[(k + 1) * size + line] as number;
      if (r2 > r1) rowUp += r2 - r1;
      else rowDown += r1 - r2;
      if (c2 > c1) colUp += c2 - c1;
      else colDown += c1 - c2;
      if (r1 !== 0 && r2 !== 0) smooth += Math.abs(r1 - r2);
      if (c1 !== 0 && c2 !== 0) smooth += Math.abs(c1 - c2);
    }
    mono += Math.min(rowUp, rowDown) + Math.min(colUp, colDown);
  }
  const last = size - 1;
  const corners = [e[0], e[last], e[last * size], e[last * size + last]];
  const cornerBonus = max > 0 && corners.includes(max) ? max : 0;
  return (
    EVAL_WEIGHTS.empty * empties -
    EVAL_WEIGHTS.monotonicity * mono -
    EVAL_WEIGHTS.smoothness * smooth +
    EVAL_WEIGHTS.corner * cornerBonus
  );
}

/** Row-major indexes of empty cells. */
export function emptyIndexes(board: Board): number[] {
  const out: number[] = [];
  board.cells.forEach((c, i) => {
    if (c === null) out.push(i);
  });
  return out;
}

/** Copy of `board` with `exponent` placed at `index` (a hypothetical spawn; never the real stream). */
export function placeTile(board: Board, index: number, exponent: Exponent): Board {
  const cells = board.cells.slice();
  cells[index] = exponent;
  return { size: board.size, cells };
}
