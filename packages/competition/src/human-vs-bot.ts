import type { BotStrategy, Decimal, Exponent } from "@g2048/contracts";
import { assertDecimal, assertExponentOrNull, compareDecimal, compareExponent } from "./decimal.js";
import { fail, requireId } from "./errors.js";

/**
 * Human-vs-bot results board: its own scope, separate from human duel Elo (never rated) and
 * from the bot league (bot-vs-bot only). One row per (account, opponent bot), where the
 * opponent is strategy@botVersion. Exact values only.
 *
 * Order: opponent key asc, then wins desc, draws desc, best score desc (exact), best max
 * exponent desc, accountId asc. `rank` restarts at 1 for every opponent bot.
 * Each match counts once; a repeated matchId is rejected.
 */

export type HumanVsBotGame = {
  readonly matchId: string;
  readonly accountId: string;
  readonly bot: { readonly strategy: BotStrategy; readonly botVersion: string };
  /** From the human's point of view. */
  readonly result: "win" | "draw" | "loss";
  readonly humanScore: Decimal;
  readonly humanMaxExponent: Exponent | null;
};

export type HumanVsBotRow = {
  readonly rank: number;
  readonly opponent: string;
  readonly strategy: BotStrategy;
  readonly botVersion: string;
  readonly accountId: string;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  readonly bestScore: Decimal;
  readonly bestScoreMatchId: string;
  readonly bestMaxExponent: Exponent | null;
};

type Acc = {
  -readonly [K in keyof Omit<HumanVsBotRow, "rank">]: HumanVsBotRow[K];
};

export function computeHumanVsBotBoard(games: readonly HumanVsBotGame[]): HumanVsBotRow[] {
  const seen = new Set<string>();
  const rows = new Map<string, Acc>();
  games.forEach((g, i) => {
    const matchId = requireId(g.matchId, `games[${i}].matchId`);
    const accountId = requireId(g.accountId, `games[${i}].accountId`);
    if (g.bot === null || typeof g.bot !== "object") fail("VALIDATION_ERROR", `games[${i}].bot is required`);
    const strategy = requireId(g.bot.strategy, `games[${i}].bot.strategy`) as BotStrategy;
    const botVersion = requireId(g.bot.botVersion, `games[${i}].bot.botVersion`);
    assertDecimal(g.humanScore, `games[${i}].humanScore`);
    assertExponentOrNull(g.humanMaxExponent, `games[${i}].humanMaxExponent`);
    if (g.result !== "win" && g.result !== "draw" && g.result !== "loss") {
      fail("VALIDATION_ERROR", `games[${i}].result must be win, draw, or loss`);
    }
    if (seen.has(matchId)) fail("VALIDATION_ERROR", `match ${matchId} appears twice`);
    seen.add(matchId);

    const opponent = `${strategy}@${botVersion}`;
    const key = JSON.stringify([opponent, accountId]);
    const acc: Acc = rows.get(key) ?? {
      opponent,
      strategy,
      botVersion,
      accountId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      bestScore: g.humanScore,
      bestScoreMatchId: matchId,
      bestMaxExponent: null,
    };
    acc.played += 1;
    if (g.result === "win") acc.won += 1;
    else if (g.result === "draw") acc.drawn += 1;
    else acc.lost += 1;
    const byScore = compareDecimal(g.humanScore, acc.bestScore);
    if (byScore > 0 || (byScore === 0 && matchId < acc.bestScoreMatchId)) {
      acc.bestScore = g.humanScore;
      acc.bestScoreMatchId = matchId;
    }
    if (compareExponent(g.humanMaxExponent, acc.bestMaxExponent) > 0)
      acc.bestMaxExponent = g.humanMaxExponent;
    rows.set(key, acc);
  });

  const sorted = [...rows.values()].sort(
    (x, y) =>
      codeUnits(x.opponent, y.opponent) ||
      y.won - x.won ||
      y.drawn - x.drawn ||
      compareDecimal(y.bestScore, x.bestScore) ||
      compareExponent(y.bestMaxExponent, x.bestMaxExponent) ||
      codeUnits(x.accountId, y.accountId),
  );
  let rank = 0;
  let previous: string | null = null;
  return sorted.map((acc) => {
    rank = acc.opponent === previous ? rank + 1 : 1;
    previous = acc.opponent;
    return { rank, ...acc };
  });
}

function codeUnits(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
