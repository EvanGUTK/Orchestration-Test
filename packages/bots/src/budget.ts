import type { AbortSignalLike, BotStopReason } from "./types.ts";

/** Thrown inside a search to unwind when a budget is exhausted or cancellation is requested. */
export class StopSearch extends Error {
  readonly reason: Exclude<BotStopReason, "complete" | "fallback">;
  constructor(reason: Exclude<BotStopReason, "complete" | "fallback">) {
    super(`search stopped: ${reason}`);
    this.name = "StopSearch";
    this.reason = reason;
  }
}

const SIGNAL_CHECK_MASK = 31; // every 32 nodes
const TIME_CHECK_MASK = 255; // every 256 nodes

/** Node budget + cooperative cancellation + optional wall-time budget. Deterministic when `deadline` is null. */
export class Budget {
  nodes = 0;
  readonly limit: number;
  readonly signal: AbortSignalLike | undefined;
  readonly deadline: number | null;
  readonly now: () => number;

  constructor(limit: number, signal: AbortSignalLike | undefined, deadline: number | null, now: () => number) {
    this.limit = limit;
    this.signal = signal;
    this.deadline = deadline;
    this.now = now;
  }

  /** Count one node (a slide or an evaluation); throws StopSearch when no more work is allowed. */
  tick(): void {
    this.nodes++;
    if (this.nodes > this.limit) {
      this.nodes--; // the over-budget node was not performed
      throw new StopSearch("node-budget");
    }
    if ((this.nodes & SIGNAL_CHECK_MASK) === 0 && this.signal?.aborted) throw new StopSearch("cancelled");
    if (this.deadline !== null && (this.nodes & TIME_CHECK_MASK) === 0 && this.now() >= this.deadline) throw new StopSearch("time-budget");
  }

  /** Count a node without enforcing the limit (used only for the mandatory legal-move baseline). */
  free(): void {
    this.nodes++;
  }
}
