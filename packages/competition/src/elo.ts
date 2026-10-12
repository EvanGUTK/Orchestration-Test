import { ELO, ELO_ALGORITHM_VERSION } from "@g2048/contracts";
import { fail } from "./errors.js";

export type EloOutcome = 1 | 0.5 | 0;
export type EloDelta = { readonly deltaA: number; readonly deltaB: number };

export { ELO_ALGORITHM_VERSION };

/**
 * elo-v1. expectedA = 1 / (1 + 10^((ratingB - ratingA) / 400)), K = 24,
 * deltaA = roundHalfAwayFromZero(K * (outcomeA - expectedA)), deltaB = -deltaA.
 *
 * Rounding rule: round half away from zero on the magnitude (|x| = n + 0.5 rounds to n + 1,
 * then the sign is restored), so the rule is symmetric under negation; `-0` is normalized to 0.
 *
 * Seat symmetry: the raw delta is always computed from the perspective of the lower-rated
 * seat (seat A when ratings are equal) and negated for the other seat, so swapping seats
 * (eloDelta(rB, rA, 1 - oA)) yields exactly the mirrored integers even where floating-point
 * evaluation of 1 - expectedA and expectedB would differ in the last bit. Because
 * deltaB = -deltaA by construction, the combined rating is conserved exactly.
 *
 * Ratings must be safe integers; the result is always an integer in [-K, K].
 */
export function eloDelta(ratingA: number, ratingB: number, outcomeA: EloOutcome): EloDelta {
  assertRating(ratingA, "ratingA");
  assertRating(ratingB, "ratingB");
  if (outcomeA !== 1 && outcomeA !== 0.5 && outcomeA !== 0) {
    fail("VALIDATION_ERROR", "outcomeA must be 1, 0.5, or 0");
  }
  const deltaA =
    ratingA <= ratingB
      ? rawDelta(ratingA, ratingB, outcomeA)
      : negate(rawDelta(ratingB, ratingA, (1 - outcomeA) as EloOutcome));
  return { deltaA, deltaB: negate(deltaA) };
}

/** Expected score of a player rated `rating` against `opponentRating`. */
export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / ELO.scale));
}

/** Round half away from zero, computed without the `x + 0.5` float trap. */
export function roundHalfAwayFromZero(x: number): number {
  if (!Number.isFinite(x)) fail("VALIDATION_ERROR", "cannot round a non-finite value");
  const magnitude = Math.abs(x);
  const floor = Math.floor(magnitude);
  const rounded = magnitude - floor >= 0.5 ? floor + 1 : floor;
  return x < 0 ? negate(rounded) : rounded;
}

function rawDelta(rating: number, opponentRating: number, outcome: EloOutcome): number {
  return roundHalfAwayFromZero(ELO.k * (outcome - expectedScore(rating, opponentRating)));
}

function negate(n: number): number {
  return n === 0 ? 0 : -n;
}

function assertRating(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("VALIDATION_ERROR", `${field} must be a safe integer rating`);
  }
}
