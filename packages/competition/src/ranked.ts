import { DomainError, RANKED_RULES, SEAT_MOVE_CAP } from "@2048/contracts";
import type { Ruleset } from "@2048/contracts";

export type AttemptStatus = "active" | "completed" | "forfeited";

export type AttemptRecord = { gameId: string; status: AttemptStatus };

export type ChallengeInfo = { status: "open" | "closed"; rulesetVersion: string };

export type AttemptDecision =
  | { action: "create" }
  | { action: "resume"; gameId: string }
  | { action: "reject"; code: "FORBIDDEN"; reason: "guest" | "challenge-closed" | "attempt-consumed" | "ruleset-unsupported" };

/**
 * Ranked-challenge attempt policy (POST /challenges/:id/attempts):
 * - guests never enter a ranked ladder;
 * - one official attempt per account/challenge: an `active` attempt is resumed (also after a restart);
 * - `completed` and `forfeited` attempts are consumed: no retry (abandoning forfeits);
 * - a closed challenge starts nothing new and resumes nothing.
 * `existing` is the account's attempt for this challenge, or null.
 */
export function decideAttempt(input: {
  identityKind: "user" | "guest";
  challenge: ChallengeInfo;
  existing: AttemptRecord | null;
}): AttemptDecision {
  if (input.identityKind !== "user") return { action: "reject", code: "FORBIDDEN", reason: "guest" };
  if (input.challenge.rulesetVersion !== RANKED_RULES.version) return { action: "reject", code: "FORBIDDEN", reason: "ruleset-unsupported" };
  if (input.challenge.status !== "open") return { action: "reject", code: "FORBIDDEN", reason: "challenge-closed" };
  const { existing } = input;
  if (existing === null) return { action: "create" };
  if (existing.status === "active") return { action: "resume", gameId: existing.gameId };
  return { action: "reject", code: "FORBIDDEN", reason: "attempt-consumed" };
}

/** Is `rules` exactly the official ranked rules (4x4, 500-move cap, no undo, official flag)? */
export function isOfficialRankedRules(rules: Ruleset): boolean {
  return (
    rules.official &&
    rules.version === RANKED_RULES.version &&
    rules.boardSize === 4 &&
    rules.moveCap === SEAT_MOVE_CAP &&
    rules.undoLimit === 0 &&
    rules.startTiles === RANKED_RULES.startTiles &&
    rules.spawnFourTenths === RANKED_RULES.spawnFourTenths
  );
}

/** Throw FORBIDDEN for any request on an official game that is not a plain move/forfeit (undo, custom options). */
export function assertRankedRequestAllowed(request: { kind: "move" | "forfeit" | "undo" | "custom-options" }): void {
  if (request.kind === "undo") throw new DomainError("FORBIDDEN", "undo is not allowed in ranked play");
  if (request.kind === "custom-options") throw new DomainError("FORBIDDEN", "custom rules are not allowed in ranked play");
}

export type AttemptEnd = "move-cap" | "dead" | "forfeit";

/** Map a terminal game to the attempt end reason; `deadBoard` comes from the engine's isGameOver (a dead board wins over the cap when both hold). */
export function attemptEndReason(game: { status: AttemptStatus }, deadBoard: boolean): AttemptEnd | null {
  if (game.status === "forfeited") return "forfeit";
  if (game.status !== "completed") return null;
  return deadBoard ? "dead" : "move-cap";
}

/** Only completed attempts appear on the challenge leaderboard; a forfeit consumes the attempt but is not listed. */
export function isStandingEligible(status: AttemptStatus): boolean {
  return status === "completed";
}
