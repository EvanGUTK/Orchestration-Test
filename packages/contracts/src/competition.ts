import type { Decimal, Direction, Exponent } from "./domain.js";

export const ELO = { initialRating: 1000, k: 24, scale: 400 } as const;

/** Expected score 1/(1+10^((opp-rating)/400)); deltaA = round(K*(outcomeA-expectedA)); deltaB = -deltaA. */
export type DuelOutcome = "seat-a" | "seat-b" | "draw";
export type SeatId = "a" | "b";
export type SeatTerminalReason = "move-cap" | "dead-board" | "forfeit";
export type MatchStatus = "lobby" | "active" | "finished" | "abandoned-lobby";
export type MatchKind = "human-human" | "human-bot" | "bot-bot";

export type SeatResult = {
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly terminal: SeatTerminalReason | null;
};

export type RatingEvent = {
  readonly matchId: string;
  readonly accountId: string;
  readonly season: string;
  readonly rulesetVersion: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  readonly outcome: 1 | 0.5 | 0;
  readonly algorithm: string; // ELO_ALGORITHM_VERSION
  readonly idempotencyKey: string; // `${matchId}:${accountId}`
};

/**
 * Leaderboard total order (never cast scores to REAL):
 *  score desc (decimal length, then lexical), max exponent desc (length, then lexical),
 *  created_at asc, id asc. Challenge standings use attempt creation order as created_at.
 */
export const LEADERBOARD_ORDER = "score-desc,maxExponent-desc,createdAt-asc,id-asc" as const;
export type LeaderboardScope = "casual" | "challenge" | "duel-elo" | "bot-league";

export const BOT_STRATEGIES = ["random-v1", "greedy-v1", "heuristic-v1", "expectimax-v1"] as const;
export type BotStrategy = (typeof BOT_STRATEGIES)[number];
export const BOT_DIFFICULTY: Record<BotStrategy, "easy" | "medium" | "hard" | "expert"> = {
  "random-v1": "easy",
  "greedy-v1": "medium",
  "heuristic-v1": "hard",
  "expectimax-v1": "expert",
};
export type BotBudget = { readonly nodeBudget: number; readonly timeBudgetMs: number };
export type BotDecision = {
  readonly strategy: BotStrategy;
  readonly botVersion: string;
  readonly direction: Direction;
  readonly explanation: string;
  readonly nodesSearched: number;
  readonly fallback: boolean; // true when budget/cancel forced the safe legal fallback
};
