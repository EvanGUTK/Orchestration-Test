import { RULESETS } from "@g2048/contracts";
import type { Decimal, Exponent, GameMode, LeaderboardScope } from "@g2048/contracts";
import { assertDecimal, assertExponentOrNull } from "./decimal.js";
import { fail, requireId } from "./errors.js";

/**
 * Pure reducer for one account's official attempt at one ranked challenge.
 *
 *   not-started --start-or-resume--> in-progress --start-or-resume--> in-progress (resume, same game)
 *   in-progress --complete(move-cap | dead-board)--> completed
 *   in-progress --forfeit--> forfeited
 *
 * - One official attempt per account/challenge: completed and forfeited are final; any further
 *   start-or-resume is ATTEMPT_CONSUMED (forfeit consumes the attempt).
 * - An interrupted attempt resumes its original game; the command's gameId is ignored on resume.
 * - A closed challenge rejects new attempts (CHALLENGE_CLOSED) but still lets an in-progress
 *   attempt resume and finish, so a restart never strands an official attempt.
 * - Practice with the same seed is casual: see isOfficialChallengePlay / leaderboardScopeForMode.
 */

export type AttemptStatus = "not-started" | "in-progress" | "completed" | "forfeited";
export type AttemptEndReason = "move-cap" | "dead-board" | "forfeit";

export type AttemptResult = {
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
  readonly reason: AttemptEndReason;
};

export type ChallengeAttemptState = {
  readonly challengeId: string;
  readonly accountId: string;
  readonly moveCap: number;
  readonly status: AttemptStatus;
  readonly gameId: string | null;
  readonly result: AttemptResult | null;
};

export type AttemptFinalValues = {
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
};

export type ChallengeAttemptCommand =
  | { readonly type: "start-or-resume"; readonly challengeOpen: boolean; readonly gameId?: string }
  | ({ readonly type: "complete"; readonly reason: "move-cap" | "dead-board" } & AttemptFinalValues)
  | ({ readonly type: "forfeit" } & AttemptFinalValues);

export type ChallengeAttemptEvent =
  | {
      readonly type: "attempt.started";
      readonly challengeId: string;
      readonly accountId: string;
      readonly gameId: string;
    }
  | {
      readonly type: "attempt.resumed";
      readonly challengeId: string;
      readonly accountId: string;
      readonly gameId: string;
    }
  | {
      readonly type: "attempt.completed" | "attempt.forfeited";
      readonly challengeId: string;
      readonly accountId: string;
      readonly gameId: string;
      readonly result: AttemptResult;
    };

export type ChallengeAttemptTransition = {
  readonly state: ChallengeAttemptState;
  readonly events: readonly ChallengeAttemptEvent[];
};

export function newChallengeAttempt(input: {
  readonly challengeId: string;
  readonly accountId: string;
  readonly moveCap?: number;
}): ChallengeAttemptState {
  const moveCap = input.moveCap ?? RULESETS["ranked-v1"].moveCap;
  if (!Number.isSafeInteger(moveCap) || moveCap < 1)
    fail("VALIDATION_ERROR", "moveCap must be a positive integer");
  return {
    challengeId: requireId(input.challengeId, "challengeId"),
    accountId: requireId(input.accountId, "accountId"),
    moveCap,
    status: "not-started",
    gameId: null,
    result: null,
  };
}

export function reduceChallengeAttempt(
  state: ChallengeAttemptState,
  command: ChallengeAttemptCommand,
): ChallengeAttemptTransition {
  switch (command.type) {
    case "start-or-resume":
      return startOrResume(state, command.challengeOpen, command.gameId);
    case "complete":
      if (command.reason !== "move-cap" && command.reason !== "dead-board") {
        fail("VALIDATION_ERROR", "complete reason must be move-cap or dead-board; use forfeit to forfeit");
      }
      return end(state, command.reason, command);
    case "forfeit":
      return end(state, "forfeit", command);
    default:
      return fail("VALIDATION_ERROR", "unknown challenge attempt command");
  }
}

/** Official challenge play is only the ranked mode on the ranked ruleset; same-seed practice stays casual. */
export function isOfficialChallengePlay(mode: GameMode, rulesetVersion: string): boolean {
  return mode === "ranked" && rulesetVersion === RULESETS["ranked-v1"].version;
}

/**
 * Leaderboard scope a finished game may appear on. Custom practice never enters any
 * leaderboard (null); bot results only enter the separate bot league; only ranked challenge
 * attempts enter challenge standings and only human duels enter duel Elo.
 */
export function leaderboardScopeForMode(mode: GameMode): LeaderboardScope | null {
  switch (mode) {
    case "classic":
      return "casual";
    case "practice":
      return null;
    case "ranked":
      return "challenge";
    case "duel-human":
      return "duel-elo";
    case "duel-bot":
    case "bot-vs-bot":
    case "bot-exhibition":
      return "bot-league";
    default:
      return fail("VALIDATION_ERROR", "unknown game mode");
  }
}

function startOrResume(
  state: ChallengeAttemptState,
  challengeOpen: boolean,
  gameId: string | undefined,
): ChallengeAttemptTransition {
  const ids = { challengeId: state.challengeId, accountId: state.accountId };
  if (state.status === "in-progress" && state.gameId !== null) {
    return { state, events: [{ type: "attempt.resumed", ...ids, gameId: state.gameId }] };
  }
  if (state.status === "completed" || state.status === "forfeited") {
    fail("ATTEMPT_CONSUMED", `the official attempt is already ${state.status}`);
  }
  if (typeof challengeOpen !== "boolean") fail("VALIDATION_ERROR", "challengeOpen must be a boolean");
  if (!challengeOpen) fail("CHALLENGE_CLOSED", "the challenge no longer accepts new attempts");
  const id = requireId(gameId, "gameId");
  return {
    state: { ...state, status: "in-progress", gameId: id },
    events: [{ type: "attempt.started", ...ids, gameId: id }],
  };
}

function end(
  state: ChallengeAttemptState,
  reason: AttemptEndReason,
  values: AttemptFinalValues,
): ChallengeAttemptTransition {
  if (state.status === "not-started") fail("NO_ATTEMPT", "no attempt has been started");
  if (state.status !== "in-progress" || state.gameId === null) {
    fail("ATTEMPT_CONSUMED", `the official attempt is already ${state.status}`);
  }
  assertDecimal(values.score, "score");
  assertExponentOrNull(values.maxExponent, "maxExponent");
  const moves = values.acceptedMoves;
  if (!Number.isSafeInteger(moves) || moves < 0 || moves > state.moveCap) {
    fail("VALIDATION_ERROR", `acceptedMoves must be an integer in 0..${state.moveCap}`);
  }
  if (reason === "move-cap" && moves !== state.moveCap) {
    fail("VALIDATION_ERROR", `move-cap requires exactly ${state.moveCap} accepted moves`);
  }
  const result: AttemptResult = {
    score: values.score,
    maxExponent: values.maxExponent,
    acceptedMoves: moves,
    reason,
  };
  const status = reason === "forfeit" ? "forfeited" : "completed";
  return {
    state: { ...state, status, result },
    events: [
      {
        type: status === "forfeited" ? "attempt.forfeited" : "attempt.completed",
        challengeId: state.challengeId,
        accountId: state.accountId,
        gameId: state.gameId,
        result,
      },
    ],
  };
}
