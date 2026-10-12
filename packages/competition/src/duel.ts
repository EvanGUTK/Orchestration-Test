import type { DuelOutcome, SeatResult } from "@g2048/contracts";
import { assertDecimal, assertExponentOrNull, compareDecimal, compareExponent } from "./decimal.js";
import { fail } from "./errors.js";
import type { EloOutcome } from "./elo.js";

/**
 * Duel outcome per PROJECT_SCOPE "Modes and rules":
 *  - null until BOTH seats are terminal (one dead board never ends the other seat's moves);
 *  - a forfeiting seat loses regardless of score; two forfeits are a draw;
 *  - otherwise higher score wins, then higher max exponent; equal results are a draw.
 * Scores/exponents are exact decimal strings (no JS number conversion).
 */
export function decideDuel(seatA: SeatResult, seatB: SeatResult): DuelOutcome | null {
  validateSeatResult(seatA, "seatA");
  validateSeatResult(seatB, "seatB");
  if (seatA.terminal === null || seatB.terminal === null) return null;
  const forfeitA = seatA.terminal === "forfeit";
  const forfeitB = seatB.terminal === "forfeit";
  if (forfeitA && forfeitB) return "draw";
  if (forfeitA) return "seat-b";
  if (forfeitB) return "seat-a";
  const byScore = compareDecimal(seatA.score, seatB.score);
  if (byScore !== 0) return byScore > 0 ? "seat-a" : "seat-b";
  const byExponent = compareExponent(seatA.maxExponent, seatB.maxExponent);
  if (byExponent !== 0) return byExponent > 0 ? "seat-a" : "seat-b";
  return "draw";
}

/** Elo outcome (1 / 0.5 / 0) for seat A and seat B of a decided duel. */
export function duelOutcomeScores(outcome: DuelOutcome): { readonly a: EloOutcome; readonly b: EloOutcome } {
  switch (outcome) {
    case "seat-a":
      return { a: 1, b: 0 };
    case "seat-b":
      return { a: 0, b: 1 };
    case "draw":
      return { a: 0.5, b: 0.5 };
    default:
      return fail("VALIDATION_ERROR", "unknown duel outcome");
  }
}

function validateSeatResult(seat: SeatResult, field: string): void {
  assertDecimal(seat.score, `${field}.score`);
  assertExponentOrNull(seat.maxExponent, `${field}.maxExponent`);
  const t = seat.terminal;
  if (t !== null && t !== "move-cap" && t !== "dead-board" && t !== "forfeit") {
    fail("VALIDATION_ERROR", `${field}.terminal is not a known terminal reason`);
  }
}
