import type { EnginePort } from "../engine-port.js";
import { BotWorkerPool } from "./pool.js";
import type { BotWorkerPoolOptions } from "./pool.js";
import { BotRunner } from "./runner.js";
import { BotSeatDriver } from "./seat-driver.js";

export type BotServices = {
  /** The one process-wide worker pool (LIMITS.concurrentBotRunsMax threads at most). */
  readonly pool: BotWorkerPool;
  /** Bot-lab runs ("lab" priority). */
  readonly runner: BotRunner;
  /** Duel bot seats ("seat" priority, reserved slots). */
  readonly seats: BotSeatDriver;
  /** Cancels all runs and seat decisions, then terminates the workers. */
  shutdown(): Promise<void>;
};

/**
 * The single factory the server calls once at startup. Bot-lab runs and duel bot seats share
 * one worker pool, so the process never runs more than `pool.size` bot threads, and seat jobs
 * are always served first with `reservedSeatSlots` workers that lab jobs cannot occupy.
 */
export function createBotServices(
  options: BotWorkerPoolOptions & {
    /** Max simultaneously active bot-lab runs; default LIMITS.concurrentBotRunsMax. */
    readonly maxLabRuns?: number;
    readonly enginePort?: EnginePort;
    readonly now?: () => number;
  } = {},
): BotServices {
  const pool = new BotWorkerPool(options);
  const runner = new BotRunner({
    pool,
    ...(options.maxLabRuns === undefined ? {} : { maxConcurrent: options.maxLabRuns }),
    ...(options.enginePort === undefined ? {} : { enginePort: options.enginePort }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const seats = new BotSeatDriver({
    pool,
    ...(options.enginePort === undefined ? {} : { enginePort: options.enginePort }),
  });
  return {
    pool,
    runner,
    seats,
    async shutdown() {
      await Promise.all([runner.shutdown(), seats.shutdown()]);
      await pool.shutdown();
    },
  };
}
