import { chooseMove, deriveBotRng, engineAdapter } from "@g2048/bots";
import { DecisionCancelled } from "../bots/decision.js";
import type { DecisionService } from "../bots/decision.js";

/**
 * Same-thread DecisionService for tests (jsdom has no Web Worker). Runs the real @g2048/bots
 * chooseMove exactly as bot.worker.ts does, but without a clock so results are deterministic.
 */
export function inlineDecisionService(): DecisionService & { readonly calls: number } {
  let cancelled = 0;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async decide(request) {
      calls++;
      const epoch = cancelled;
      await Promise.resolve();
      if (epoch !== cancelled) throw new DecisionCancelled();
      const rng = request.rng ?? deriveBotRng(engineAdapter, request.seed);
      return chooseMove(request.state, request.rules, request.config, rng);
    },
    cancel() {
      cancelled++;
    },
  };
}
