import { createRepos } from "@2048/database";
import { boardMaxExponent } from "@2048/competition";
import type { ChangeContext } from "./games.ts";

/** An official attempt becomes final exactly when its ranked game stops being active. */
export function attemptHook(ctx: ChangeContext): void {
  const { game, next, at, raw } = ctx;
  if (!game.challengeId || next.status === "active") return;
  const status = next.status === "completed" ? "completed" : "forfeited";
  createRepos(raw).competition.finishAttempt(game.id, status, next.score, boardMaxExponent(next.board), at);
}
