import { compareDecimal } from "@2048/contracts";
import type { Board, Decimal, Exponent } from "@2048/contracts";

/** Maximum tile exponent on a board, compared as exact decimals (never via Number). "0" when the board is empty. */
export function boardMaxExponent(board: Pick<Board, "cells">): Exponent {
  let best: Exponent = "0";
  for (const cell of board.cells) {
    if (cell !== null && compareDecimal(cell, best) > 0) best = cell;
  }
  return best;
}

/** The facts a challenge standing needs from one official attempt. */
export type StandingInput = {
  /** Stable attempt identifier; final deterministic tie-break only. */
  attemptId: string;
  /** Monotone creation order (database rowid / sequence). Lower = created earlier. */
  createdOrder: number;
  score: Decimal;
  maxExponent: Exponent;
};

/**
 * Challenge standing comparator (docs/PROJECT_SCOPE.md):
 * score desc (exact), maximum exponent desc (exact), attempt creation order asc.
 * `attemptId` (UTF-16 code unit order) is appended so the order is total and stable.
 * Negative result => `a` ranks ahead of `b`.
 */
export function compareStanding(a: StandingInput, b: StandingInput): number {
  const byScore = compareDecimal(b.score, a.score);
  if (byScore !== 0) return byScore;
  const byExp = compareDecimal(b.maxExponent, a.maxExponent);
  if (byExp !== 0) return byExp;
  if (a.createdOrder !== b.createdOrder) return a.createdOrder < b.createdOrder ? -1 : 1;
  return a.attemptId === b.attemptId ? 0 : a.attemptId < b.attemptId ? -1 : 1;
}

export type RankedStanding<T extends StandingInput> = T & { rank: number };

/** Sort (without mutating the input) and assign 1-based positional ranks. Ranks are unique: creation order breaks every tie. */
export function rankStandings<T extends StandingInput>(entries: readonly T[]): RankedStanding<T>[] {
  return [...entries].sort(compareStanding).map((e, i) => ({ ...e, rank: i + 1 }));
}
