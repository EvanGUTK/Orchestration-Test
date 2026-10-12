import type { Grid } from "./sim.ts";

/**
 * Static evaluation of a board in exponent space (higher is better). Adapted from the well-known
 * row/column heuristic: empty cells, merge opportunities, monotonicity and a tile-sum penalty. It is
 * size-agnostic (3x3..8x8) and uses only the board, never the PRNG.
 */
const LOST_PENALTY = 200_000;
const MONOTONICITY_POWER = 4;
const MONOTONICITY_WEIGHT = 47;
const SUM_POWER = 3.5;
const SUM_WEIGHT = 11;
const MERGES_WEIGHT = 700;
const EMPTY_WEIGHT = 270;

export const DEAD_VALUE = -1e12;

function lineScore(grid: Grid, start: number, step: number, n: number): number {
  let empty = 0;
  let merges = 0;
  let sum = 0;
  let counter = 0;
  let prev = 0;
  let monoLeft = 0;
  let monoRight = 0;
  for (let i = 0; i < n; i++) {
    const rank = grid[start + i * step]!;
    sum += Math.pow(rank, SUM_POWER);
    if (rank === 0) {
      empty++;
    } else {
      if (prev === rank) {
        counter++;
      } else if (counter > 0) {
        merges += 1 + counter;
        counter = 0;
      }
      prev = rank;
    }
  }
  if (counter > 0) merges += 1 + counter;
  for (let i = 1; i < n; i++) {
    const a = grid[start + (i - 1) * step]!;
    const b = grid[start + i * step]!;
    if (a > b) monoLeft += Math.pow(a, MONOTONICITY_POWER) - Math.pow(b, MONOTONICITY_POWER);
    else monoRight += Math.pow(b, MONOTONICITY_POWER) - Math.pow(a, MONOTONICITY_POWER);
  }
  return LOST_PENALTY + EMPTY_WEIGHT * empty + MERGES_WEIGHT * merges - MONOTONICITY_WEIGHT * Math.min(monoLeft, monoRight) - SUM_WEIGHT * sum;
}

export function evaluate(grid: Grid, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += lineScore(grid, i * n, 1, n); // row i
    total += lineScore(grid, i, n, n); // column i
  }
  return total;
}
