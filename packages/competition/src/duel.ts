import { compareDecimal } from "@2048/contracts";
import type { Decimal, Exponent, MatchOutcome } from "@2048/contracts";

export type SeatTerminalReason = "move-cap" | "dead" | "forfeit";

/** One seat's standing in a duel. `terminalReason: null` means the seat can still move. */
export type DuelSeat = {
  terminalReason: SeatTerminalReason | null;
  score: Decimal;
  maxExponent: Exponent;
};

export type DuelDecidedBy = "forfeit" | "score" | "max-exponent" | "draw" | "double-forfeit";

export type DuelResolution =
  | {
      /** One or both seats can still move (or a seat is absent): nothing is rated, nothing is awarded. */
      status: "pending";
      outcome: null;
      decidedBy: null;
      /** Seats (0/1) still able to move. */
      waitingOn: (0 | 1)[];
    }
  | {
      /** Both seats are terminal: the outcome is final and the match may be rated exactly once. */
      status: "finished";
      outcome: MatchOutcome;
      decidedBy: DuelDecidedBy;
      waitingOn: [];
    };

/**
 * Duel outcome resolver.
 * - Rating and finalization only after BOTH seats are terminal (a dead board does not end the other seat's moves).
 * - A forfeiting seat loses regardless of score; two forfeits are a draw.
 * - Otherwise compare exact score, then maximum exponent; equal => draw.
 * Wall-clock time never decides anything.
 */
export function resolveDuel(seat0: DuelSeat, seat1: DuelSeat): DuelResolution {
  const waitingOn: (0 | 1)[] = [];
  if (seat0.terminalReason === null) waitingOn.push(0);
  if (seat1.terminalReason === null) waitingOn.push(1);
  if (waitingOn.length > 0) return { status: "pending", outcome: null, decidedBy: null, waitingOn };

  const f0 = seat0.terminalReason === "forfeit";
  const f1 = seat1.terminalReason === "forfeit";
  if (f0 && f1) return { status: "finished", outcome: "draw", decidedBy: "double-forfeit", waitingOn: [] };
  if (f0) return { status: "finished", outcome: "seat1", decidedBy: "forfeit", waitingOn: [] };
  if (f1) return { status: "finished", outcome: "seat0", decidedBy: "forfeit", waitingOn: [] };

  const byScore = compareDecimal(seat0.score, seat1.score);
  if (byScore !== 0) {
    return { status: "finished", outcome: byScore > 0 ? "seat0" : "seat1", decidedBy: "score", waitingOn: [] };
  }
  const byExp = compareDecimal(seat0.maxExponent, seat1.maxExponent);
  if (byExp !== 0) {
    return { status: "finished", outcome: byExp > 0 ? "seat0" : "seat1", decidedBy: "max-exponent", waitingOn: [] };
  }
  return { status: "finished", outcome: "draw", decidedBy: "draw", waitingOn: [] };
}

/** Elo outcome score for seat 0 (1 win, 0.5 draw, 0 loss); seat 1 receives `1 - value`. */
export function outcomeScoreForSeat0(outcome: MatchOutcome): 0 | 0.5 | 1 {
  return outcome === "seat0" ? 1 : outcome === "draw" ? 0.5 : 0;
}
