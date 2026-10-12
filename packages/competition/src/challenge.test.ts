import { GAME_MODES } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import {
  isOfficialChallengePlay,
  leaderboardScopeForMode,
  newChallengeAttempt,
  reduceChallengeAttempt,
} from "./challenge.js";
import type { ChallengeAttemptCommand, ChallengeAttemptState } from "./challenge.js";
import { CompetitionError } from "./errors.js";
import type { CompetitionErrorCode } from "./errors.js";

function expectCode(fn: () => unknown, code: CompetitionErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CompetitionError);
    expect((error as CompetitionError).code).toBe(code);
    return;
  }
  throw new Error(`expected CompetitionError ${code}`);
}

const fresh = (): ChallengeAttemptState =>
  Object.freeze(newChallengeAttempt({ challengeId: "ch1", accountId: "acc-alice" }));
const start: ChallengeAttemptCommand = { type: "start-or-resume", challengeOpen: true, gameId: "g1" };
const finalValues = { score: "12345678901234567890123", maxExponent: "40", acceptedMoves: 500 };

function started(): ChallengeAttemptState {
  return Object.freeze(reduceChallengeAttempt(fresh(), start).state);
}

describe("challenge attempt reducer", () => {
  it("starts with ranked-v1 move cap and no attempt", () => {
    expect(fresh()).toEqual({
      challengeId: "ch1",
      accountId: "acc-alice",
      moveCap: 500,
      status: "not-started",
      gameId: null,
      result: null,
    });
  });

  it("start-or-resume starts once, then resumes the same game (interrupted attempt)", () => {
    const first = reduceChallengeAttempt(fresh(), start);
    expect(first.state.status).toBe("in-progress");
    expect(first.events).toEqual([
      { type: "attempt.started", challengeId: "ch1", accountId: "acc-alice", gameId: "g1" },
    ]);
    const resumed = reduceChallengeAttempt(first.state, {
      type: "start-or-resume",
      challengeOpen: true,
      gameId: "g2",
    });
    expect(resumed.state).toBe(first.state);
    expect(resumed.events).toEqual([
      { type: "attempt.resumed", challengeId: "ch1", accountId: "acc-alice", gameId: "g1" },
    ]);
  });

  it("a closed challenge blocks new attempts but still resumes an in-progress one", () => {
    expectCode(
      () => reduceChallengeAttempt(fresh(), { type: "start-or-resume", challengeOpen: false, gameId: "g" }),
      "CHALLENGE_CLOSED",
    );
    expect(
      reduceChallengeAttempt(started(), { type: "start-or-resume", challengeOpen: false }).events[0]?.type,
    ).toBe("attempt.resumed");
  });

  it("starting requires a game id", () => {
    expectCode(
      () => reduceChallengeAttempt(fresh(), { type: "start-or-resume", challengeOpen: true }),
      "VALIDATION_ERROR",
    );
  });

  it("completion is final: a completed attempt cannot restart or end again", () => {
    const { state, events } = reduceChallengeAttempt(started(), {
      type: "complete",
      reason: "move-cap",
      ...finalValues,
    });
    expect(state.status).toBe("completed");
    expect(state.result).toEqual({ ...finalValues, reason: "move-cap" });
    expect(events[0]?.type).toBe("attempt.completed");
    Object.freeze(state);
    expectCode(() => reduceChallengeAttempt(state, start), "ATTEMPT_CONSUMED");
    expectCode(() => reduceChallengeAttempt(state, { type: "forfeit", ...finalValues }), "ATTEMPT_CONSUMED");
    expectCode(
      () => reduceChallengeAttempt(state, { type: "complete", reason: "dead-board", ...finalValues }),
      "ATTEMPT_CONSUMED",
    );
  });

  it("forfeit consumes the attempt", () => {
    const { state, events } = reduceChallengeAttempt(started(), {
      type: "forfeit",
      score: "64",
      maxExponent: "5",
      acceptedMoves: 12,
    });
    expect(state.status).toBe("forfeited");
    expect(state.result?.reason).toBe("forfeit");
    expect(events[0]?.type).toBe("attempt.forfeited");
    expectCode(() => reduceChallengeAttempt(state, start), "ATTEMPT_CONSUMED");
  });

  it("cannot end an attempt that never started", () => {
    expectCode(() => reduceChallengeAttempt(fresh(), { type: "forfeit", ...finalValues }), "NO_ATTEMPT");
    expectCode(
      () => reduceChallengeAttempt(fresh(), { type: "complete", reason: "dead-board", ...finalValues }),
      "NO_ATTEMPT",
    );
  });

  it("validates final values and move cap", () => {
    const s = started();
    expectCode(
      () =>
        reduceChallengeAttempt(s, {
          type: "complete",
          reason: "move-cap",
          ...finalValues,
          acceptedMoves: 499,
        }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () =>
        reduceChallengeAttempt(s, {
          type: "complete",
          reason: "dead-board",
          ...finalValues,
          acceptedMoves: 501,
        }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () =>
        reduceChallengeAttempt(s, { type: "complete", reason: "dead-board", ...finalValues, score: "-5" }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () =>
        reduceChallengeAttempt(s, { type: "complete", reason: "forfeit" as "dead-board", ...finalValues }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () => reduceChallengeAttempt(s, { type: "restart" } as unknown as ChallengeAttemptCommand),
      "VALIDATION_ERROR",
    );
  });
});

describe("official vs casual play", () => {
  it("practice with the same seed stays casual; only ranked on ranked-v1 is official", () => {
    expect(isOfficialChallengePlay("ranked", "ranked-v1")).toBe(true);
    expect(isOfficialChallengePlay("practice", "practice-v1")).toBe(false);
    expect(isOfficialChallengePlay("practice", "ranked-v1")).toBe(false);
    expect(isOfficialChallengePlay("classic", "classic-v1")).toBe(false);
    expect(isOfficialChallengePlay("ranked", "practice-v1")).toBe(false);
  });

  it("separates leaderboard scopes: practice none, bots only in the bot league", () => {
    const scopes = Object.fromEntries(GAME_MODES.map((m) => [m, leaderboardScopeForMode(m)]));
    expect(scopes).toEqual({
      classic: "casual",
      practice: null,
      ranked: "challenge",
      "bot-exhibition": "bot-league",
      "duel-human": "duel-elo",
      "duel-bot": "bot-league",
      "bot-vs-bot": "bot-league",
    });
  });
});
