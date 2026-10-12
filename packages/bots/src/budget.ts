export type AbortReason = "node-budget" | "time-budget" | "cancelled";

/** Cooperative cancellation flag; the worker runner backs it with a SharedArrayBuffer. */
export type CancelSignal = { readonly cancelled: boolean };

/** Thrown inside a search when the budget is exhausted; never escapes chooseMove. */
export class SearchAborted extends Error {
  readonly reason: AbortReason;

  constructor(reason: AbortReason) {
    super(`search aborted: ${reason}`);
    this.name = "SearchAborted";
    this.reason = reason;
  }
}

/** How often (in nodes) the injected clock is consulted. */
export const CLOCK_CHECK_INTERVAL = 16;

/**
 * Hard search budget. `tick()` is called before every node is expanded; it throws
 * SearchAborted once `nodeBudget` nodes were used, the signal is cancelled, or (only when a
 * clock was injected) the time budget elapsed. Without a clock the budget is purely
 * node-based and the search is fully deterministic.
 */
export class SearchBudget {
  nodes = 0;
  private readonly deadline: number | null;

  constructor(
    private readonly nodeBudget: number,
    timeBudgetMs: number,
    private readonly signal: CancelSignal | undefined,
    private readonly now: (() => number) | undefined,
  ) {
    this.deadline = now === undefined ? null : now() + timeBudgetMs;
  }

  tick(): void {
    if (this.signal?.cancelled === true) throw new SearchAborted("cancelled");
    if (this.nodes >= this.nodeBudget) throw new SearchAborted("node-budget");
    if (this.deadline !== null && this.now !== undefined && this.nodes % CLOCK_CHECK_INTERVAL === 0) {
      if (this.now() >= this.deadline) throw new SearchAborted("time-budget");
    }
    this.nodes += 1;
  }
}
