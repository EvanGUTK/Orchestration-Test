import { BOT_DIFFICULTY, BOT_SEED_NAMESPACE, BOT_STRATEGIES, LIMITS } from "@g2048/contracts";
import type {
  BotConfig,
  BotDecision,
  BotStrategy,
  Direction,
  GameState,
  RandomState,
  Ruleset,
} from "@g2048/contracts";
import { SearchAborted, SearchBudget } from "./budget.js";
import type { AbortReason, CancelSignal } from "./budget.js";
import type { EnginePort } from "./engine-port.js";
import { STRATEGIES } from "./strategies.js";

/** Version of this bot implementation, recorded in every BotDecision and run result. */
export const BOT_VERSION = "bots-1.0.0";

export type BotErrorCode = "VALIDATION_ERROR";

export class BotError extends Error {
  readonly code: BotErrorCode;

  constructor(code: BotErrorCode, message: string) {
    super(message);
    this.name = "BotError";
    this.code = code;
  }
}

export type ChooseMoveOptions = {
  /**
   * Injected monotonic clock (ms). When omitted the time budget is not enforced and the
   * decision depends only on board, rules, config, and bot RNG (fully deterministic). The
   * worker runner injects performance.now; pure callers such as tournaments omit it.
   */
  readonly now?: () => number;
};

export type ChooseMoveResult =
  | { readonly kind: "move"; readonly decision: BotDecision; readonly rng: RandomState }
  | {
      readonly kind: "no-legal-move";
      readonly reason: "dead-board" | "game-not-active";
      readonly rng: RandomState;
    };

/** The bot's private RandomState for `seed`; independent of the game's spawn stream. */
export function deriveBotRng(port: EnginePort, seed: string): RandomState {
  return port.deriveRandomState(BOT_SEED_NAMESPACE, seed);
}

export function validateBotConfig(config: BotConfig): BotConfig {
  if (config === null || typeof config !== "object")
    throw new BotError("VALIDATION_ERROR", "config is required");
  const strategy = BOT_STRATEGIES.find((s) => s === config.strategy);
  if (strategy === undefined) throw new BotError("VALIDATION_ERROR", "unknown bot strategy");
  const { nodeBudget, timeBudgetMs } = config;
  if (!Number.isSafeInteger(nodeBudget) || nodeBudget < 1 || nodeBudget > LIMITS.botNodeBudgetMax) {
    throw new BotError("VALIDATION_ERROR", `nodeBudget must be an integer in 1..${LIMITS.botNodeBudgetMax}`);
  }
  if (!Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > LIMITS.botTimeBudgetMsMax) {
    throw new BotError(
      "VALIDATION_ERROR",
      `timeBudgetMs must be an integer in 1..${LIMITS.botTimeBudgetMsMax}`,
    );
  }
  return { strategy, nodeBudget, timeBudgetMs };
}

export function difficultyOf(strategy: BotStrategy): (typeof BOT_DIFFICULTY)[BotStrategy] {
  return BOT_DIFFICULTY[strategy];
}

/**
 * CONTRACT-001 chooseMove, bound to an engine port.
 *
 * Information boundary (BOT-03): only `state.status` and `state.board` are read; `state.rng`
 * (the game's spawn stream) is never touched. Randomness comes solely from `botRng`.
 *
 * Budgets: every searched node costs one unit of `config.nodeBudget`; with an injected clock
 * the search also stops at `config.timeBudgetMs`; `signal.cancelled` is polled at every node.
 * When the budget or cancellation stops a search before any answer exists, the first legal
 * move in DIRECTIONS order is returned with `fallback: true`. The returned direction is always
 * a member of engine legalMoves(board); a board without legal moves yields `no-legal-move`.
 */
export function createChooseMove(port: EnginePort) {
  return function chooseMove(
    state: GameState,
    rules: Ruleset,
    config: BotConfig,
    botRng: RandomState,
    signal?: CancelSignal,
    options: ChooseMoveOptions = {},
  ): ChooseMoveResult {
    const { strategy, nodeBudget, timeBudgetMs } = validateBotConfig(config);
    if (state.status !== "active") return { kind: "no-legal-move", reason: "game-not-active", rng: botRng };
    const board = state.board;
    const legal = port.legalMoves(board);
    if (legal.length === 0) return { kind: "no-legal-move", reason: "dead-board", rng: botRng };

    const budget = new SearchBudget(nodeBudget, timeBudgetMs, signal, options.now);
    const decide = (
      direction: Direction,
      explanation: string,
      fallback: boolean,
      rng: RandomState,
    ): ChooseMoveResult => ({
      kind: "move",
      decision: {
        strategy,
        botVersion: BOT_VERSION,
        direction,
        explanation,
        nodesSearched: budget.nodes,
        fallback,
      },
      rng,
    });
    const fallbackMove = (why: string): ChooseMoveResult => {
      const direction = legal[0] as Direction;
      return decide(
        direction,
        `${strategy}: ${why}; fallback to first legal move ${direction}`,
        true,
        botRng,
      );
    };

    try {
      const choice = STRATEGIES[strategy]({ port, board, rules, legal, rng: botRng, budget });
      if (!legal.includes(choice.direction)) return fallbackMove("search proposed an illegal move");
      return decide(choice.direction, choice.explanation, false, choice.rng);
    } catch (error) {
      if (error instanceof SearchAborted) return fallbackMove(abortText(error.reason));
      throw error;
    }
  };
}

export type ChooseMove = ReturnType<typeof createChooseMove>;

function abortText(reason: AbortReason): string {
  switch (reason) {
    case "node-budget":
      return "node budget exhausted before the first search depth completed";
    case "time-budget":
      return "time budget exhausted before the first search depth completed";
    case "cancelled":
      return "search cancelled";
  }
}
