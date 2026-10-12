import { describe, expect, it } from "vitest";
import { CompetitionError } from "./errors.js";
import { computeProfileStats } from "./profile-stats.js";
import type { GameSummary } from "./profile-stats.js";

let n = 0;
function g(partial: Partial<GameSummary> & Pick<GameSummary, "mode" | "score">): GameSummary {
  n += 1;
  return {
    gameId: `g${String(n).padStart(3, "0")}`,
    rulesetVersion: partial.mode === "ranked" ? "ranked-v1" : "classic-v1",
    status: "completed",
    maxExponent: partial.score === "0" ? null : "7",
    acceptedMoves: 10,
    createdAt: `2026-10-12T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    ...partial,
  };
}

const HUGE = (2n ** 80n + 5n).toString();

describe("computeProfileStats", () => {
  const games = [
    g({ mode: "classic", score: "1500", maxExponent: "8" }),
    g({ mode: "classic", score: HUGE, maxExponent: "40" }),
    g({ mode: "classic", score: "1500", maxExponent: "9", status: "forfeited" }),
    g({ mode: "practice", rulesetVersion: "practice-v1", score: "0" }),
    g({ mode: "ranked", score: "3000", challengeId: "ch-s1-1", createdAt: "2026-10-12T12:00:00.000Z" }),
    g({ mode: "ranked", score: "2000", challengeId: "ch-s1-2", createdAt: "2026-10-12T11:00:00.000Z" }),
    g({ mode: "classic", score: "4", status: "active", maxExponent: "2" }),
  ];
  const stats = computeProfileStats({
    games,
    duels: [
      { matchId: "m1", kind: "human-human", result: "win", finishedAt: "t1" },
      { matchId: "m2", kind: "human-human", result: "draw", finishedAt: "t2" },
      { matchId: "m3", kind: "human-bot", result: "loss", finishedAt: "t3" },
      { matchId: "m4", kind: "human-human", result: "loss", finishedAt: "t4" },
    ],
    ratingEvents: [
      {
        matchId: "m4",
        season: "s1",
        rulesetVersion: "duel-v1",
        before: 1012,
        after: 1000,
        delta: -12,
        at: "2026-10-12T13:00:00.000Z",
      },
      {
        matchId: "m1",
        season: "s1",
        rulesetVersion: "duel-v1",
        before: 1000,
        after: 1012,
        delta: 12,
        at: "2026-10-12T12:00:00.000Z",
      },
    ],
  });

  it("counts games by status", () => {
    expect(stats).toMatchObject({ gamesPlayed: 7, completedGames: 5, forfeitedGames: 1 });
  });

  it("computes exact personal bests per mode and ruleset", () => {
    expect(stats.personalBests).toEqual([
      {
        mode: "classic",
        rulesetVersion: "classic-v1",
        gamesPlayed: 4,
        bestScore: HUGE,
        bestScoreGameId: games[1]?.gameId,
        bestMaxExponent: "40",
      },
      {
        mode: "practice",
        rulesetVersion: "practice-v1",
        gamesPlayed: 1,
        bestScore: "0",
        bestScoreGameId: games[3]?.gameId,
        bestMaxExponent: null,
      },
      {
        mode: "ranked",
        rulesetVersion: "ranked-v1",
        gamesPlayed: 2,
        bestScore: "3000",
        bestScoreGameId: games[4]?.gameId,
        bestMaxExponent: "7",
      },
    ]);
  });

  it("ties on best score go to the earlier game (LEADERBOARD_ORDER)", () => {
    const a = g({ mode: "classic", score: "100", maxExponent: "5", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = g({ mode: "classic", score: "100", maxExponent: "5", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(computeProfileStats({ games: [b, a] }).personalBests[0]?.bestScoreGameId).toBe(a.gameId);
  });

  it("buckets scores by exact power of two", () => {
    expect(stats.scoreDistribution).toEqual([
      { label: "0", minInclusive: "0", maxExclusive: null, count: 1 },
      { label: "2^2", minInclusive: "4", maxExclusive: "8", count: 1 },
      { label: "2^10", minInclusive: "1024", maxExclusive: "2048", count: 3 },
      { label: "2^11", minInclusive: "2048", maxExclusive: "4096", count: 1 },
      { label: "2^80", minInclusive: (2n ** 80n).toString(), maxExclusive: (2n ** 81n).toString(), count: 1 },
    ]);
    // 2000 sits in [1024, 2048); 3000 in [2048, 4096).
  });

  it("builds a max-tile histogram in exact exponent order", () => {
    expect(stats.maxTileHistogram).toEqual([
      { exponent: "2", count: 1 },
      { exponent: "7", count: 2 },
      { exponent: "8", count: 1 },
      { exponent: "9", count: 1 },
      { exponent: "40", count: 1 },
    ]);
  });

  it("separates rated duel W/D/L from games against bots", () => {
    expect(stats.duels).toEqual({
      rated: { wins: 1, draws: 1, losses: 1 },
      vsBot: { wins: 0, draws: 0, losses: 1 },
    });
  });

  it("orders ranked history and rating history by time", () => {
    expect(stats.rankedHistory.map((r) => [r.challengeId, r.score])).toEqual([
      ["ch-s1-2", "2000"],
      ["ch-s1-1", "3000"],
    ]);
    expect(stats.ratingHistory.map((r) => [r.matchId, r.rating, r.delta])).toEqual([
      ["m1", 1012, 12],
      ["m4", 1000, -12],
    ]);
  });

  it("rejects inexact or malformed input", () => {
    expect(() => computeProfileStats({ games: [g({ mode: "classic", score: "1.5" })] })).toThrow(
      CompetitionError,
    );
    expect(() =>
      computeProfileStats({ games: [g({ mode: "classic", score: "1", maxExponent: "0" })] }),
    ).toThrow(CompetitionError);
    expect(() =>
      computeProfileStats({
        games: [],
        ratingEvents: [
          { matchId: "m", season: "s", rulesetVersion: "r", before: 1000, after: 1013, delta: 12, at: "t" },
        ],
      }),
    ).toThrow(CompetitionError);
    expect(() =>
      computeProfileStats({
        games: [],
        duels: [{ matchId: "m", kind: "bot-bot" as "human-bot", result: "win", finishedAt: "t" }],
      }),
    ).toThrow(CompetitionError);
  });

  it("handles an empty profile", () => {
    expect(computeProfileStats({ games: [] })).toEqual({
      gamesPlayed: 0,
      completedGames: 0,
      forfeitedGames: 0,
      personalBests: [],
      scoreDistribution: [],
      maxTileHistogram: [],
      duels: { rated: { wins: 0, draws: 0, losses: 0 }, vsBot: { wins: 0, draws: 0, losses: 0 } },
      rankedHistory: [],
      ratingHistory: [],
    });
  });
});
