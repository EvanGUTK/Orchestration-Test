import type { BotConfig, GameState, RandomState, Ruleset, SeatId } from "@g2048/contracts";
import type { MatchState } from "@g2048/competition";
import { validateBotConfig } from "../choose-move.js";
import { engineAdapter } from "../engine-adapter.js";
import type { EnginePort } from "../engine-port.js";
import { planBotSeat } from "../seat-driver.js";
import type { BotSeatAction } from "../seat-driver.js";
import { BotRunnerError, BotWorkerPool } from "./pool.js";
import type { BotPoolTask, BotWorkerPoolOptions } from "./pool.js";

export type BotSeatRequest = {
  readonly match: MatchState;
  readonly seat: SeatId;
  readonly game: GameState;
  readonly rules: Ruleset;
  readonly config: BotConfig;
  readonly botRng: RandomState;
};

export type BotSeatDriverOptions = {
  /** Shared process-wide pool (see createBotServices); seat decisions run as "seat" jobs. */
  readonly pool?: BotWorkerPool;
  /** Options for a private pool when `pool` is omitted (tests, single-purpose tools). */
  readonly poolOptions?: BotWorkerPoolOptions;
  readonly enginePort?: EnginePort;
};

/**
 * Async bot-seat driver for the server (human-vs-bot and bot-vs-bot matches).
 *
 * decide() first runs planBotSeat on the caller's thread (cheap, no search). Only "decide"
 * plans go to the shared BotWorkerPool as high-priority "seat" jobs, so searches never run on
 * the API event loop and bot-lab work can never starve a duel seat. Each seat key
 * (`matchId:seat`) has at most one decision in flight. cancel(key) or an AbortSignal aborts
 * the search and rejects with CANCELLED, so a cancelled decision is never applied.
 */
export class BotSeatDriver {
  private readonly inFlight = new Map<string, BotPoolTask>();
  private readonly port: EnginePort;
  readonly pool: BotWorkerPool;
  private readonly ownsPool: boolean;
  private closed = false;

  constructor(options: BotSeatDriverOptions = {}) {
    this.ownsPool = options.pool === undefined;
    this.pool = options.pool ?? new BotWorkerPool(options.poolOptions);
    this.port = options.enginePort ?? engineAdapter;
  }

  /** Decisions currently searching or queued. */
  get pending(): number {
    return this.inFlight.size;
  }

  async decide(request: BotSeatRequest, options: { signal?: AbortSignal } = {}): Promise<BotSeatAction> {
    if (this.closed) throw new BotRunnerError("VALIDATION_ERROR", "driver is shut down");
    const plan = planBotSeat(request.match, request.seat, request.game, this.port);
    validateBotConfig(request.config);
    if (plan.kind !== "decide") return plan;
    const key = `${request.match.id}:${request.seat}`;
    if (this.inFlight.has(key)) {
      throw new BotRunnerError("DUPLICATE_RUN", `seat ${key} already has a decision in flight`);
    }
    if (options.signal?.aborted === true) {
      throw new BotRunnerError("CANCELLED", `bot decision for ${key} was cancelled`);
    }
    const task = this.pool.submit("seat", {
      state: request.game,
      rules: request.rules,
      config: request.config,
      botRng: request.botRng,
    });
    this.inFlight.set(key, task);
    const onAbort = (): void => {
      this.cancel(key);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { result } = await task.promise;
      if (result.kind === "no-legal-move") {
        return {
          kind: "terminal",
          command: {
            type: "seat-terminal",
            seat: request.seat,
            reason: "dead-board",
            score: request.game.score,
            maxExponent: this.port.maxExponent(request.game.board),
            acceptedMoves: request.game.acceptedMoves,
          },
        };
      }
      return {
        kind: "move",
        direction: result.decision.direction,
        decision: result.decision,
        rng: result.rng,
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    }
  }

  /** Abort the decision for `matchId:seat`, if any. Returns whether something was cancelled. */
  cancel(key: string): boolean {
    const task = this.inFlight.get(key);
    if (task === undefined) return false;
    this.inFlight.delete(key);
    task.cancel();
    return true;
  }

  /** Cancel every pending decision (and stop the pool if this driver owns it). */
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const key of [...this.inFlight.keys()]) this.cancel(key);
    if (this.ownsPool) await this.pool.shutdown();
  }
}
