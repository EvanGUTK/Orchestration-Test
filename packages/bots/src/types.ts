import type { Board, BotConfig, BotStrategy, Direction } from "@2048/contracts";

/** Structural subset of AbortSignal so a SharedArrayBuffer-backed flag can be used inside worker threads. */
export type AbortSignalLike = { readonly aborted: boolean };

export type BotStopReason =
  | "complete" // search finished everything it set out to do (or the strategy needs no search)
  | "node-budget" // node budget exhausted; best completed result used
  | "time-budget" // wall-time budget exhausted (never used when ignoreTimeBudget is set)
  | "cancelled" // cooperative cancellation; best completed result (or first legal move) used
  | "fallback"; // the chosen direction was not legal; the first legal move was substituted

/** Bot-private tie-break stream (never the game PRNG). Matches the engine's createRng shape. */
export type BotRng = { next(): number; below(n: number): number };

export type ChooseMoveOptions = {
  /** Distinguishes moves of one game: the stream is derived from `${seed}#${moveIndex}` (stateless, replayable). */
  moveIndex?: number;
  signal?: AbortSignalLike;
  /** Public rule: spawn probability of a 4 in tenths (default 1). Used by chance nodes only. */
  spawnFourTenths?: number;
  /** Deterministic modes set this: only the node budget bounds the search. */
  ignoreTimeBudget?: boolean;
  /** Clock for the time budget (default performance.now). Injectable for tests. */
  now?: () => number;
  /** Override the tie-break stream (tests). */
  rng?: BotRng;
};

export type BotDecision = {
  direction: Direction;
  /** One short human-readable sentence. */
  explanation: string;
  /** Search nodes visited (slides + evaluations), always <= nodeBudget (plus the legal-move baseline). */
  nodes: number;
  stopReason: BotStopReason;
  /** Deepest fully-completed search depth (0 = no lookahead). */
  depthReached: number;
  strategy: BotStrategy;
  botVersion: string;
};

export type BotMetadata = {
  botVersion: string;
  strategy: BotStrategy;
  difficulty: 1 | 2 | 3 | 4;
  label: string;
  seed: string;
  nodeBudget: number;
  timeBudgetMs: number;
  depth: number;
};

export type ChooseMove = (board: Board, config: BotConfig, options?: ChooseMoveOptions) => BotDecision;
export type { BotConfig, BotStrategy };
