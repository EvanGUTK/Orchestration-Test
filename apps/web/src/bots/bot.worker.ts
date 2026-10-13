// Bot search runs here, never on the UI thread. The node budget is always enforced; the time budget is
// enforced too because a clock (performance.now) is injected (CONTRACT-001 C9).
import { chooseMove, deriveBotRng, engineAdapter } from "@g2048/bots";
import type { DecisionRequest } from "./decision.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; request: DecisionRequest }>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  const { id, request } = event.data;
  try {
    const rng = request.rng ?? deriveBotRng(engineAdapter, request.seed);
    const result = chooseMove(request.state, request.rules, request.config, rng, undefined, {
      now: () => performance.now(),
    });
    scope.postMessage({ id, ok: true, result });
  } catch (error) {
    scope.postMessage({ id, ok: false, message: error instanceof Error ? error.message : "Bot error" });
  }
};
