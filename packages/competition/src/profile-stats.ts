import type { Decimal, Exponent, GameMode, MatchKind } from "@g2048/contracts";
import { assertDecimal, assertExponentOrNull, compareExponent } from "./decimal.js";
import { fail, requireId } from "./errors.js";
import { compareStanding } from "./standings.js";

/**
 * Profile statistics for one account, computed from stored summaries. Exact values only:
 * scores stay decimal strings / BigInt, exponents stay strings, and no value is converted to a
 * JS number. Timestamps are fixed-format UTC ISO strings compared by code unit.
 */

export type GameSummary = {
  readonly gameId: string;
  readonly mode: GameMode;
  readonly rulesetVersion: string;
  readonly status: "active" | "completed" | "forfeited";
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
  readonly createdAt: string;
  /** Ranked games: the challenge the attempt belongs to. */
  readonly challengeId?: string | null;
};

export type DuelSummary = {
  readonly matchId: string;
  readonly kind: Exclude<MatchKind, "bot-bot">;
  /** Result from this account's point of view. */
  readonly result: "win" | "draw" | "loss";
  readonly finishedAt: string;
};

export type RatingHistoryEntry = {
  readonly matchId: string;
  readonly season: string;
  readonly rulesetVersion: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  readonly at: string;
};

export type PersonalBest = {
  readonly mode: GameMode;
  readonly rulesetVersion: string;
  readonly gamesPlayed: number;
  readonly bestScore: Decimal;
  readonly bestScoreGameId: string;
  readonly bestMaxExponent: Exponent | null;
};

export type ScoreBucket = {
  /** "0" for score 0, else "2^k" for scores in [2^k, 2^(k+1)). */
  readonly label: string;
  readonly minInclusive: Decimal;
  /** null for the "0" bucket. */
  readonly maxExclusive: Decimal | null;
  readonly count: number;
};

export type WinDrawLoss = { readonly wins: number; readonly draws: number; readonly losses: number };

export type ProfileStats = {
  readonly gamesPlayed: number;
  readonly completedGames: number;
  readonly forfeitedGames: number;
  /** Sorted by mode, then rulesetVersion. */
  readonly personalBests: readonly PersonalBest[];
  /** Non-empty buckets only, ascending. */
  readonly scoreDistribution: readonly ScoreBucket[];
  /** Max-tile exponent histogram, ascending by exponent; games with an empty board are skipped. */
  readonly maxTileHistogram: readonly { readonly exponent: Exponent; readonly count: number }[];
  readonly duels: { readonly rated: WinDrawLoss; readonly vsBot: WinDrawLoss };
  /** Ranked challenge attempts in creation order. */
  readonly rankedHistory: readonly {
    readonly at: string;
    readonly gameId: string;
    readonly challengeId: string | null;
    readonly score: Decimal;
    readonly maxExponent: Exponent | null;
    readonly status: GameSummary["status"];
  }[];
  /** Duel Elo after each rated match, in time order. */
  readonly ratingHistory: readonly {
    readonly at: string;
    readonly matchId: string;
    readonly season: string;
    readonly rulesetVersion: string;
    readonly rating: number;
    readonly delta: number;
  }[];
};

export function computeProfileStats(input: {
  readonly games: readonly GameSummary[];
  readonly duels?: readonly DuelSummary[];
  readonly ratingEvents?: readonly RatingHistoryEntry[];
}): ProfileStats {
  const games = input.games.map(validateGame);
  const bests = new Map<
    string,
    { mode: GameMode; rulesetVersion: string; played: number; best: GameSummary; bestExp: Exponent | null }
  >();
  const buckets = new Map<number, number>(); // bit length (0 for score 0) -> count
  const tiles = new Map<string, number>();

  for (const g of games) {
    const key = JSON.stringify([g.mode, g.rulesetVersion]);
    const entry = bests.get(key);
    if (entry === undefined) {
      bests.set(key, {
        mode: g.mode,
        rulesetVersion: g.rulesetVersion,
        played: 1,
        best: g,
        bestExp: g.maxExponent,
      });
    } else {
      entry.played += 1;
      if (compareStanding(asStanding(g), asStanding(entry.best)) < 0) entry.best = g;
      if (compareExponent(g.maxExponent, entry.bestExp) > 0) entry.bestExp = g.maxExponent;
    }
    const bits = BigInt(g.score).toString(2).length - (g.score === "0" ? 1 : 0);
    buckets.set(bits, (buckets.get(bits) ?? 0) + 1);
    if (g.maxExponent !== null) tiles.set(g.maxExponent, (tiles.get(g.maxExponent) ?? 0) + 1);
  }

  const personalBests = [...bests.values()]
    .sort((x, y) => codeUnits(x.mode, y.mode) || codeUnits(x.rulesetVersion, y.rulesetVersion))
    .map((e) => ({
      mode: e.mode,
      rulesetVersion: e.rulesetVersion,
      gamesPlayed: e.played,
      bestScore: e.best.score,
      bestScoreGameId: e.best.gameId,
      bestMaxExponent: e.bestExp,
    }));

  const scoreDistribution = [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([bits, count]) =>
      bits === 0
        ? { label: "0", minInclusive: "0", maxExclusive: null, count }
        : {
            label: `2^${bits - 1}`,
            minInclusive: (1n << BigInt(bits - 1)).toString(),
            maxExclusive: (1n << BigInt(bits)).toString(),
            count,
          },
    );

  const maxTileHistogram = [...tiles.entries()]
    .sort((x, y) => compareExponent(x[0], y[0]))
    .map(([exponent, count]) => ({ exponent, count }));

  const rated = { wins: 0, draws: 0, losses: 0 };
  const vsBot = { wins: 0, draws: 0, losses: 0 };
  for (const d of input.duels ?? []) {
    requireId(d.matchId, "matchId");
    const target =
      d.kind === "human-human"
        ? rated
        : d.kind === "human-bot"
          ? vsBot
          : fail("VALIDATION_ERROR", "duel kind must be human-human or human-bot");
    if (d.result === "win") target.wins += 1;
    else if (d.result === "draw") target.draws += 1;
    else if (d.result === "loss") target.losses += 1;
    else fail("VALIDATION_ERROR", "duel result must be win, draw, or loss");
  }

  const rankedHistory = games
    .filter((g) => g.mode === "ranked")
    .sort((x, y) => codeUnits(x.createdAt, y.createdAt) || codeUnits(x.gameId, y.gameId))
    .map((g) => ({
      at: g.createdAt,
      gameId: g.gameId,
      challengeId: g.challengeId ?? null,
      score: g.score,
      maxExponent: g.maxExponent,
      status: g.status,
    }));

  const ratingHistory = [...(input.ratingEvents ?? [])]
    .map((e) => {
      if (
        !Number.isSafeInteger(e.after) ||
        !Number.isSafeInteger(e.delta) ||
        e.after !== e.before + e.delta
      ) {
        fail("VALIDATION_ERROR", "rating history entries need integer before + delta = after");
      }
      return e;
    })
    .sort((x, y) => codeUnits(x.at, y.at) || codeUnits(x.matchId, y.matchId))
    .map((e) => ({
      at: e.at,
      matchId: e.matchId,
      season: e.season,
      rulesetVersion: e.rulesetVersion,
      rating: e.after,
      delta: e.delta,
    }));

  return {
    gamesPlayed: games.length,
    completedGames: games.filter((g) => g.status === "completed").length,
    forfeitedGames: games.filter((g) => g.status === "forfeited").length,
    personalBests,
    scoreDistribution,
    maxTileHistogram,
    duels: { rated, vsBot },
    rankedHistory,
    ratingHistory,
  };
}

function asStanding(g: GameSummary) {
  return { id: g.gameId, score: g.score, maxExponent: g.maxExponent, createdAt: g.createdAt };
}

function codeUnits(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function validateGame(g: GameSummary, i: number): GameSummary {
  requireId(g.gameId, `games[${i}].gameId`);
  requireId(g.mode, `games[${i}].mode`);
  requireId(g.rulesetVersion, `games[${i}].rulesetVersion`);
  assertDecimal(g.score, `games[${i}].score`);
  assertExponentOrNull(g.maxExponent, `games[${i}].maxExponent`);
  if (g.status !== "active" && g.status !== "completed" && g.status !== "forfeited") {
    fail("VALIDATION_ERROR", `games[${i}].status is unknown`);
  }
  if (typeof g.createdAt !== "string") fail("VALIDATION_ERROR", `games[${i}].createdAt must be a string`);
  return g;
}
