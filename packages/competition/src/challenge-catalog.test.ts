import type { RatingEvent } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import {
  buildChallengeCatalog,
  challengeId,
  challengeSeed,
  challengeStatus,
  rolloverSeason,
} from "./challenge-catalog.js";
import { newChallengeAttempt, reduceChallengeAttempt } from "./challenge.js";
import { CompetitionError } from "./errors.js";
import { createMatch, reduceMatch } from "./match.js";
import { applyRatingEvent, currentRating, initialSeasons } from "./season.js";
import type { SeasonsState } from "./season.js";

function rate(seasons: SeasonsState, matchId: string, a: string, b: string): SeasonsState {
  const season = seasons.activeSeason as string;
  let m = createMatch({
    id: matchId,
    kind: "human-human",
    season,
    creator: { kind: "human", accountId: a },
  }).state;
  m = reduceMatch(m, { type: "join", participant: { kind: "human", accountId: b } }).state;
  m = reduceMatch(m, {
    type: "seat-terminal",
    seat: "a",
    reason: "move-cap",
    score: "900",
    maxExponent: "7",
    acceptedMoves: 500,
  }).state;
  m = reduceMatch(m, {
    type: "seat-terminal",
    seat: "b",
    reason: "dead-board",
    score: "100",
    maxExponent: "5",
    acceptedMoves: 90,
  }).state;
  m = reduceMatch(m, {
    type: "finish",
    ratings: { a: currentRating(seasons, a, "duel-v1"), b: currentRating(seasons, b, "duel-v1") },
  }).state;
  return m.ratingEvents.reduce((s, e: RatingEvent) => applyRatingEvent(s, e).state, seasons);
}

describe("challenge catalog", () => {
  it("derives deterministic IDs and seeds per season", () => {
    expect(challengeId("s1", 3)).toBe("ch-s1-3");
    expect(challengeSeed("s1", 3)).toBe("challenge:s1:3");
    const catalog = buildChallengeCatalog("2026-q4", 3);
    expect(catalog).toEqual([
      {
        id: "ch-2026-q4-1",
        season: "2026-q4",
        index: 1,
        seed: "challenge:2026-q4:1",
        rulesetVersion: "ranked-v1",
        moveCap: 500,
      },
      {
        id: "ch-2026-q4-2",
        season: "2026-q4",
        index: 2,
        seed: "challenge:2026-q4:2",
        rulesetVersion: "ranked-v1",
        moveCap: 500,
      },
      {
        id: "ch-2026-q4-3",
        season: "2026-q4",
        index: 3,
        seed: "challenge:2026-q4:3",
        rulesetVersion: "ranked-v1",
        moveCap: 500,
      },
    ]);
    expect(buildChallengeCatalog("2026-q4", 3)).toEqual(catalog);
  });

  it("validates season ids and indexes", () => {
    expect(() => challengeId("bad:season", 1)).toThrow(CompetitionError);
    expect(() => challengeId("", 1)).toThrow(CompetitionError);
    expect(() => challengeSeed("s1", 0)).toThrow(CompetitionError);
    expect(() => buildChallengeCatalog("s1", 1001)).toThrow(CompetitionError);
  });

  it("is open only in the active season and until closed explicitly", () => {
    const { seasons, challenges } = rolloverSeason(initialSeasons(), [], "s1", 2);
    const [c1, c2] = challenges as [(typeof challenges)[0], (typeof challenges)[0]];
    expect(challengeStatus(c1, seasons)).toBe("open");
    expect(challengeStatus(c1, seasons, new Set([c1.id]))).toBe("closed");
    expect(challengeStatus(c2, seasons, new Set([c1.id]))).toBe("open");
    const next = rolloverSeason(seasons, challenges, "s2", 1);
    expect(challengeStatus(c1, next.seasons)).toBe("closed");
    expect(challengeStatus(next.challenges[0] as typeof c1, next.seasons)).toBe("open");
  });

  it("closed challenges block new attempts but let in-progress attempts resume", () => {
    const first = rolloverSeason(initialSeasons(), [], "s1", 1);
    const c = first.challenges[0] as (typeof first.challenges)[0];
    let attempt = newChallengeAttempt({ challengeId: c.id, accountId: "alice" });
    attempt = reduceChallengeAttempt(attempt, {
      type: "start-or-resume",
      challengeOpen: challengeStatus(c, first.seasons) === "open",
      gameId: "g1",
    }).state;
    const second = rolloverSeason(first.seasons, first.challenges, "s2", 1);
    const open = challengeStatus(c, second.seasons) === "open";
    expect(
      reduceChallengeAttempt(attempt, { type: "start-or-resume", challengeOpen: open }).events[0]?.type,
    ).toBe("attempt.resumed");
    expect(() =>
      reduceChallengeAttempt(newChallengeAttempt({ challengeId: c.id, accountId: "bob" }), {
        type: "start-or-resume",
        challengeOpen: open,
        gameId: "g2",
      }),
    ).toThrow(expect.objectContaining({ code: "CHALLENGE_CLOSED" }));
  });
});

describe("rolloverSeason", () => {
  it("starts the first season without an archive", () => {
    const r = rolloverSeason(initialSeasons(), [], "s1", 2);
    expect(r.archive).toBeNull();
    expect(r.seasons.activeSeason).toBe("s1");
    expect(r.events).toEqual([{ type: "season.started", season: "s1", initialRating: 1000 }]);
    expect(r.initialRating).toBe(1000);
  });

  it("archives the final ladder, closes old challenges, and resets ratings to 1000", () => {
    const first = rolloverSeason(initialSeasons(), [], "s1", 2);
    let seasons = rate(first.seasons, "m1", "alice", "bob");
    seasons = rate(seasons, "m2", "carol", "alice");
    const r = rolloverSeason(seasons, first.challenges, "s2", 3);
    expect(r.events.map((e) => e.type)).toEqual(["season.archived", "season.started"]);
    expect(r.archive?.season).toBe("s1");
    expect(r.archive?.closedChallengeIds).toEqual(["ch-s1-1", "ch-s1-2"]);
    expect(r.archive?.finalRatings.map((x) => [x.accountId, x.rating, x.played])).toEqual([
      ["carol", 1012, 1],
      ["alice", 1000, 2],
      ["bob", 988, 1],
    ]);
    expect(r.seasons.ladders.s1?.status).toBe("archived");
    expect(currentRating(r.seasons, "alice", "duel-v1")).toBe(1000);
    expect(currentRating(r.seasons, "carol", "duel-v1")).toBe(1000);
    expect(r.challenges.map((c) => c.id)).toEqual(["ch-s2-1", "ch-s2-2", "ch-s2-3"]);
  });

  it("rejects a catalog from another season and duplicate seasons", () => {
    const first = rolloverSeason(initialSeasons(), [], "s1", 1);
    expect(() => rolloverSeason(first.seasons, buildChallengeCatalog("s9", 1), "s2", 1)).toThrow(
      CompetitionError,
    );
    expect(() => rolloverSeason(first.seasons, first.challenges, "s1", 1)).toThrow(
      expect.objectContaining({ code: "SEASON_EXISTS" }),
    );
  });
});
