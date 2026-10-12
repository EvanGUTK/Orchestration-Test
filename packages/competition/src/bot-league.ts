import type { BotStrategy, Decimal, DuelOutcome, Exponent } from "@g2048/contracts";
import { assertDecimal, assertExponentOrNull } from "./decimal.js";
import { fail, requireId } from "./errors.js";

/**
 * Bot league standings (LeaderboardScope "bot-league"). Inputs are finished bot-vs-bot games
 * only; a human seat is rejected so bot results can never mix with human ladders or Elo
 * (human-vs-bot results belong on their own board). A league entrant is the triple
 * strategy + botVersion + nodeBudget, so the same algorithm at a different budget or version is
 * a different entrant.
 *
 * Points: win 1, draw 1/2, loss 0, kept exactly as half-points. Scores are exact decimals:
 * `totalScore` is exact; `averageScore` is the exact quotient truncated to 2 decimal places
 * (display only); ordering compares averages exactly by cross-multiplication.
 *
 * Order: points desc, wins desc, exact average score desc, entrant key asc (code units).
 */

export type BotLeagueSeat = {
  readonly kind: "bot";
  readonly strategy: BotStrategy;
  readonly botVersion: string;
  readonly nodeBudget: number;
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
};

export type BotLeagueGame = {
  readonly a: BotLeagueSeat;
  readonly b: BotLeagueSeat;
  readonly outcome: DuelOutcome;
};

export type BotLeagueRow = {
  readonly rank: number;
  readonly key: string;
  readonly strategy: BotStrategy;
  readonly botVersion: string;
  readonly nodeBudget: number;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  /** Exact points as a decimal string, e.g. "3.5". */
  readonly points: string;
  readonly halfPoints: number;
  readonly totalScore: Decimal;
  /** totalScore / played truncated to 2 decimals (display); "0.00" when unplayed. */
  readonly averageScore: string;
  readonly bestScore: Decimal;
  readonly bestMaxExponent: Exponent | null;
};

export function botLeagueKey(seat: Pick<BotLeagueSeat, "strategy" | "botVersion" | "nodeBudget">): string {
  return `${seat.strategy}@${seat.botVersion}/${seat.nodeBudget}`;
}

type Acc = {
  key: string;
  strategy: BotStrategy;
  botVersion: string;
  nodeBudget: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  total: bigint;
  best: bigint;
  bestExp: bigint | null;
};

export function computeBotLeague(games: readonly BotLeagueGame[]): BotLeagueRow[] {
  const rows = new Map<string, Acc>();
  const add = (seat: BotLeagueSeat, points: 1 | 0.5 | 0): void => {
    const key = botLeagueKey(seat);
    const acc = rows.get(key) ?? {
      key,
      strategy: seat.strategy,
      botVersion: seat.botVersion,
      nodeBudget: seat.nodeBudget,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      total: 0n,
      best: -1n,
      bestExp: null,
    };
    const score = BigInt(seat.score);
    acc.played += 1;
    if (points === 1) acc.won += 1;
    else if (points === 0.5) acc.drawn += 1;
    else acc.lost += 1;
    acc.total += score;
    if (score > acc.best) acc.best = score;
    if (seat.maxExponent !== null) {
      const e = BigInt(seat.maxExponent);
      if (acc.bestExp === null || e > acc.bestExp) acc.bestExp = e;
    }
    rows.set(key, acc);
  };

  games.forEach((game, i) => {
    validateSeat(game.a, `games[${i}].a`);
    validateSeat(game.b, `games[${i}].b`);
    switch (game.outcome) {
      case "seat-a":
        add(game.a, 1);
        add(game.b, 0);
        break;
      case "seat-b":
        add(game.a, 0);
        add(game.b, 1);
        break;
      case "draw":
        add(game.a, 0.5);
        add(game.b, 0.5);
        break;
      default:
        fail("VALIDATION_ERROR", `games[${i}].outcome is not a duel outcome`);
    }
  });

  const sorted = [...rows.values()].sort((x, y) => {
    const hx = 2 * x.won + x.drawn;
    const hy = 2 * y.won + y.drawn;
    if (hx !== hy) return hy - hx;
    if (x.won !== y.won) return y.won - x.won;
    const ax = x.total * BigInt(y.played);
    const ay = y.total * BigInt(x.played);
    if (ax !== ay) return ax > ay ? -1 : 1;
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });

  return sorted.map((acc, i) => {
    const halfPoints = 2 * acc.won + acc.drawn;
    return {
      rank: i + 1,
      key: acc.key,
      strategy: acc.strategy,
      botVersion: acc.botVersion,
      nodeBudget: acc.nodeBudget,
      played: acc.played,
      won: acc.won,
      drawn: acc.drawn,
      lost: acc.lost,
      points: halfPoints % 2 === 0 ? String(halfPoints / 2) : `${(halfPoints - 1) / 2}.5`,
      halfPoints,
      totalScore: acc.total.toString(),
      averageScore: truncatedQuotient(acc.total, acc.played, 2),
      bestScore: acc.best.toString(),
      bestMaxExponent: acc.bestExp === null ? null : acc.bestExp.toString(),
    };
  });
}

/** numerator / denominator truncated to `places` decimals, exact (no floating point). */
export function truncatedQuotient(numerator: bigint, denominator: number, places: number): string {
  if (denominator === 0) return `0.${"0".repeat(places)}`;
  const scale = 10n ** BigInt(places);
  const scaled = (numerator * scale) / BigInt(denominator);
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(places, "0");
  return places === 0 ? whole.toString() : `${whole}.${frac}`;
}

function validateSeat(seat: BotLeagueSeat, field: string): void {
  if (seat === null || typeof seat !== "object") fail("VALIDATION_ERROR", `${field} is required`);
  if ((seat as { kind: string }).kind !== "bot") {
    fail("VALIDATION_ERROR", `${field} must be a bot seat; human results never enter the bot league`);
  }
  requireId(seat.strategy, `${field}.strategy`);
  requireId(seat.botVersion, `${field}.botVersion`);
  if (!Number.isSafeInteger(seat.nodeBudget) || seat.nodeBudget < 1) {
    fail("VALIDATION_ERROR", `${field}.nodeBudget must be a positive integer`);
  }
  assertDecimal(seat.score, `${field}.score`);
  assertExponentOrNull(seat.maxExponent, `${field}.maxExponent`);
}
