import { BOT_VERSION, DomainError } from "@2048/contracts";
import type { BotConfig, BotStrategy } from "@2048/contracts";
import type { BotMetadata } from "./types.ts";

export { BOT_VERSION };

export const BOT_STRATEGY_INFO: Record<BotStrategy, { difficulty: 1 | 2 | 3 | 4; label: string; defaultDepth: number }> = {
  random: { difficulty: 1, label: "Random legal move", defaultDepth: 0 },
  greedy: { difficulty: 2, label: "Greedy merge score", defaultDepth: 1 },
  heuristic: { difficulty: 3, label: "Heuristic search", defaultDepth: 3 },
  expectimax: { difficulty: 4, label: "Bounded expectimax", defaultDepth: 4 },
};
export const BOT_STRATEGIES = Object.keys(BOT_STRATEGY_INFO) as BotStrategy[];

export const BOT_LIMITS = {
  maxNodeBudget: 5_000_000,
  maxTimeBudgetMs: 60_000,
  maxDepth: 8,
  maxSeedLength: 128,
} as const;

export const DEFAULT_NODE_BUDGET = 20_000;
export const DEFAULT_TIME_BUDGET_MS = 250;

export function defaultBotConfig(strategy: BotStrategy, seed: string): BotConfig {
  return { strategy, seed, nodeBudget: DEFAULT_NODE_BUDGET, timeBudgetMs: DEFAULT_TIME_BUDGET_MS };
}

/** Depth actually searched for a config (search depth is further bounded by the node budget). */
export function effectiveDepth(config: BotConfig): number {
  return config.depth ?? BOT_STRATEGY_INFO[config.strategy].defaultDepth;
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
}

/** Validate untrusted config (HTTP body, stored run). Returns a normalized copy or throws VALIDATION_ERROR. */
export function validateBotConfig(input: unknown): BotConfig {
  if (typeof input !== "object" || input === null) throw new DomainError("VALIDATION_ERROR", "bot config must be an object");
  const c = input as Record<string, unknown>;
  if (typeof c.strategy !== "string" || !(c.strategy in BOT_STRATEGY_INFO)) {
    throw new DomainError("VALIDATION_ERROR", `strategy must be one of ${BOT_STRATEGIES.join(", ")}`);
  }
  if (typeof c.seed !== "string" || c.seed.length === 0 || c.seed.length > BOT_LIMITS.maxSeedLength) {
    throw new DomainError("VALIDATION_ERROR", `seed must be a string of 1..${BOT_LIMITS.maxSeedLength} characters`);
  }
  if (!isIntInRange(c.nodeBudget, 1, BOT_LIMITS.maxNodeBudget)) {
    throw new DomainError("VALIDATION_ERROR", `nodeBudget must be an integer from 1 to ${BOT_LIMITS.maxNodeBudget}`);
  }
  if (!isIntInRange(c.timeBudgetMs, 1, BOT_LIMITS.maxTimeBudgetMs)) {
    throw new DomainError("VALIDATION_ERROR", `timeBudgetMs must be an integer from 1 to ${BOT_LIMITS.maxTimeBudgetMs}`);
  }
  const out: BotConfig = { strategy: c.strategy as BotStrategy, seed: c.seed, nodeBudget: c.nodeBudget, timeBudgetMs: c.timeBudgetMs };
  if (c.depth !== undefined) {
    if (!isIntInRange(c.depth, 1, BOT_LIMITS.maxDepth)) throw new DomainError("VALIDATION_ERROR", `depth must be an integer from 1 to ${BOT_LIMITS.maxDepth}`);
    out.depth = c.depth;
  }
  return out;
}

/** Version/params metadata recorded with every bot result (BOT-01). */
export function describeBot(config: BotConfig): BotMetadata {
  const info = BOT_STRATEGY_INFO[config.strategy];
  return {
    botVersion: BOT_VERSION,
    strategy: config.strategy,
    difficulty: info.difficulty,
    label: info.label,
    seed: config.seed,
    nodeBudget: config.nodeBudget,
    timeBudgetMs: config.timeBudgetMs,
    depth: effectiveDepth(config),
  };
}
