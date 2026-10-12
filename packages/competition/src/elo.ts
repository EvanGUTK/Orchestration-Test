import { DomainError, RATING_ALGORITHM_VERSION } from "@2048/contracts";
import type { MatchOutcome, RatingEvent } from "@2048/contracts";
import { outcomeScoreForSeat0 } from "./duel.ts";

/** Elo v1 parameters (versioned via RATING_ALGORITHM_VERSION = "elo-v1"). */
export const ELO_START_RATING = 1000;
export const ELO_K = 24;
export const ELO_ALGORITHM = RATING_ALGORITHM_VERSION;

function assertRating(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new DomainError("VALIDATION_ERROR", `${name} must be a safe integer rating`);
}

/** Standard expected score: 1 / (1 + 10^((opponent - rating) / 400)). */
export function expectedScore(rating: number, opponentRating: number): number {
  assertRating(rating, "rating");
  assertRating(opponentRating, "opponentRating");
  return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
}

/** Round half away from zero, after snapping to 9 decimals so platform ulp noise never flips a .5 boundary. */
export function roundHalfAwayFromZero(value: number): number {
  const snapped = Number(value.toFixed(9));
  const r = Math.sign(snapped) * Math.round(Math.abs(snapped));
  return r === 0 ? 0 : r; // normalise -0
}

/**
 * One integer delta for seat A (the same value, negated, applies to seat B): the
 * ladder total is conserved exactly. `scoreA` is 1 / 0.5 / 0.
 */
export function eloDeltaForA(ratingA: number, ratingB: number, scoreA: 0 | 0.5 | 1): number {
  return roundHalfAwayFromZero(ELO_K * (scoreA - expectedScore(ratingA, ratingB)));
}

export type EloResult = { deltaA: number; deltaB: number; afterA: number; afterB: number };

export function applyElo(ratingA: number, ratingB: number, scoreA: 0 | 0.5 | 1): EloResult {
  const deltaA = eloDeltaForA(ratingA, ratingB, scoreA);
  const deltaB = deltaA === 0 ? 0 : -deltaA;
  return { deltaA, deltaB, afterA: ratingA + deltaA, afterB: ratingB + deltaB };
}

/** Idempotent rating-event key: one event per (algorithm, match, account). */
export function ratingEventKey(matchId: string, accountId: string, algorithm: string = ELO_ALGORITHM): string {
  return `${algorithm}:${matchId}:${accountId}`;
}

export type RatedSeat = { accountId: string; rating: number };

export type RateMatchInput = {
  matchId: string;
  seasonId: string;
  rulesetVersion: string;
  seat0: RatedSeat;
  seat1: RatedSeat;
  outcome: MatchOutcome;
};

/**
 * Build the two RatingEvents (seat 0 then seat 1) for a finished human-vs-human match.
 * Pure: persistence must insert both under the unique idempotency keys inside one transaction.
 * Bots never reach this function (see `isRatable` in match.ts).
 */
export function rateMatch(input: RateMatchInput): [RatingEvent, RatingEvent] {
  if (input.seat0.accountId === input.seat1.accountId) {
    throw new DomainError("FORBIDDEN", "a match cannot be rated between an account and itself");
  }
  assertRating(input.seat0.rating, "seat0.rating");
  assertRating(input.seat1.rating, "seat1.rating");
  const s0 = outcomeScoreForSeat0(input.outcome);
  const s1 = (1 - s0) as 0 | 0.5 | 1;
  const r = applyElo(input.seat0.rating, input.seat1.rating, s0);
  const base = { matchId: input.matchId, seasonId: input.seasonId, rulesetVersion: input.rulesetVersion, algorithm: ELO_ALGORITHM } as const;
  return [
    { ...base, accountId: input.seat0.accountId, before: input.seat0.rating, after: r.afterA, delta: r.deltaA, outcome: s0, idempotencyKey: ratingEventKey(input.matchId, input.seat0.accountId) },
    { ...base, accountId: input.seat1.accountId, before: input.seat1.rating, after: r.afterB, delta: r.deltaB, outcome: s1, idempotencyKey: ratingEventKey(input.matchId, input.seat1.accountId) },
  ];
}
