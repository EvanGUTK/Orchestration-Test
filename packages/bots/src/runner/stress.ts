import { LIMITS, RULESETS } from "@g2048/contracts";
import type { BotStrategy, GameState, RandomState, Ruleset } from "@g2048/contracts";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { deriveBotRng, validateBotConfig } from "../choose-move.js";
import { engineAdapter } from "../engine-adapter.js";
import { BotRunnerError, BotWorkerPool } from "./pool.js";
import type { BotDecisionOutput } from "./pool.js";

export type StressBotsOptions = {
  /** Simultaneous bot games (each with one search in flight); 1..LIMITS.concurrentBotRunsMax. Default 4. */
  readonly games?: number;
  /** Default expectimax-v1 (the "expert" bot). */
  readonly strategy?: BotStrategy;
  readonly budget: { readonly nodeBudget: number; readonly timeBudgetMs: number };
  /** How long to keep the bots busy. */
  readonly durationMs: number;
  /** Game seed prefix; game i uses `${seed}-${i}-${n}` for its n-th game. Default "stress". */
  readonly seed?: string;
  /** Interval of the manual lag probe (ms). Default 20. */
  readonly probeIntervalMs?: number;
  readonly rules?: Ruleset;
};

export type StressBotsResult = {
  readonly strategy: BotStrategy;
  readonly games: number;
  readonly budget: { readonly nodeBudget: number; readonly timeBudgetMs: number };
  readonly requestedDurationMs: number;
  readonly elapsedMs: number;
  /** perf_hooks.monitorEventLoopDelay (resolution 10 ms) histogram, raw nanoseconds. */
  readonly eventLoopDelay: {
    readonly resolutionMs: number;
    readonly count: number;
    readonly minNs: number;
    readonly maxNs: number;
    readonly meanNs: number;
    readonly stddevNs: number;
    readonly percentilesNs: Readonly<Record<string, number>>;
  };
  /** Raw probe samples: how late each setInterval tick fired versus the previous tick + interval (ms). */
  readonly lagSamplesMs: readonly number[];
  readonly probeIntervalMs: number;
  /** Per game slot: every decision's round-trip latency on the caller's thread (ms). */
  readonly slots: readonly {
    readonly slot: number;
    readonly gamesPlayed: number;
    readonly moves: number;
    readonly nodesSearched: number;
    readonly fallbacks: number;
    readonly decisionLatencyMs: readonly number[];
  }[];
};

/**
 * OPS-06 readiness hook (Node only). Runs `games` hard bots at once on a private worker pool
 * while measuring the caller's event-loop delay with perf_hooks.monitorEventLoopDelay and a
 * setInterval lag probe. Returns only measured raw data; interpretation (thresholds, pass/fail)
 * belongs to the quality lane's performance suite.
 */
export async function stressBots(options: StressBotsOptions): Promise<StressBotsResult> {
  const games = options.games ?? 4;
  const strategy = options.strategy ?? "expectimax-v1";
  const rules = options.rules ?? RULESETS["duel-v1"];
  const seed = options.seed ?? "stress";
  const probeIntervalMs = options.probeIntervalMs ?? 20;
  if (!Number.isSafeInteger(games) || games < 1 || games > LIMITS.concurrentBotRunsMax) {
    throw new BotRunnerError("VALIDATION_ERROR", `games must be 1..${LIMITS.concurrentBotRunsMax}`);
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0 || options.durationMs > 600_000) {
    throw new BotRunnerError("VALIDATION_ERROR", "durationMs must be in (0, 600000]");
  }
  const config = validateBotConfig({
    strategy,
    nodeBudget: options.budget.nodeBudget,
    timeBudgetMs: options.budget.timeBudgetMs,
  });
  const pool = new BotWorkerPool({ size: games, reservedSeatSlots: 0 });
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const lagSamplesMs: number[] = [];
  let lastTick = performance.now();
  const probe = setInterval(() => {
    const t = performance.now();
    lagSamplesMs.push(Math.max(0, t - lastTick - probeIntervalMs));
    lastTick = t;
  }, probeIntervalMs);

  const started = performance.now();
  const deadline = started + options.durationMs;
  histogram.enable();

  const runSlot = async (slot: number) => {
    let gamesPlayed = 0;
    let moves = 0;
    let nodes = 0;
    let fallbacks = 0;
    const latency: number[] = [];
    let state: GameState | null = null;
    let rng: RandomState | null = null;
    while (performance.now() < deadline) {
      if (state === null || state.status !== "active") {
        const gameSeed = `${seed}-${slot}-${gamesPlayed}`;
        state = engineAdapter.newGame(rules, gameSeed);
        rng = deriveBotRng(engineAdapter, gameSeed);
        gamesPlayed += 1;
      }
      const t0 = performance.now();
      const output: BotDecisionOutput = await pool.submit("seat", {
        state,
        rules,
        config,
        botRng: rng as RandomState,
      }).promise;
      const result = output.result;
      latency.push(performance.now() - t0);
      if (result.kind === "no-legal-move") {
        state = null;
        continue;
      }
      rng = result.rng;
      nodes += result.decision.nodesSearched;
      if (result.decision.fallback) fallbacks += 1;
      state = engineAdapter.applyMove(state, result.decision.direction, rules).state;
      moves += 1;
    }
    return { slot, gamesPlayed, moves, nodesSearched: nodes, fallbacks, decisionLatencyMs: latency };
  };

  try {
    const slots = await Promise.all(Array.from({ length: games }, (_, i) => runSlot(i)));
    const elapsedMs = performance.now() - started;
    histogram.disable();
    return {
      strategy,
      games,
      budget: { nodeBudget: config.nodeBudget, timeBudgetMs: config.timeBudgetMs },
      requestedDurationMs: options.durationMs,
      elapsedMs,
      eventLoopDelay: {
        resolutionMs: 10,
        count: histogram.count,
        minNs: histogram.min,
        maxNs: histogram.max,
        meanNs: histogram.mean,
        stddevNs: histogram.stddev,
        percentilesNs: Object.fromEntries(
          [...histogram.percentiles.entries()].map(([p, v]) => [String(p), v]),
        ),
      },
      lagSamplesMs,
      probeIntervalMs,
      slots,
    };
  } finally {
    histogram.disable();
    clearInterval(probe);
    await pool.shutdown();
  }
}
