import type { SeatId } from "@g2048/contracts";
import type { BotSeatDriver } from "@g2048/bots/runner";
import type { FastifyBaseLogger } from "fastify";
import { DbBusyError } from "@g2048/database";
import { AppError } from "../http/errors.js";
import type { MatchService } from "./service.js";

export type MatchBotDriverOptions = {
  /** Pause between bot moves (pacing for spectators); 0 = as fast as the pool allows. */
  moveDelayMs?: number;
};

/**
 * Drives bot seats of human-bot and bot-bot matches. Each bot seat runs its own loop:
 * plan + decide on the shared worker pool ("seat" priority, BotSeatDriver) -> apply the move through
 * MatchService.botMove (same idempotent command path as humans; commandId derived from the seat game
 * revision) -> repeat until the seat is terminal or the match ends. Nothing here blocks the event
 * loop or waits on a human seat. After a restart, kick() re-plans every active bot seat from the DB.
 */
export class MatchBotDriver {
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(
    private readonly service: MatchService,
    private readonly seats: BotSeatDriver,
    private readonly log: FastifyBaseLogger,
    private readonly options: MatchBotDriverOptions = {},
  ) {}

  /** Ensures every bot seat of the match has a running loop. */
  kick(matchId: string): void {
    if (this.stopped) return;
    for (const seat of ["a", "b"] as const) {
      const key = `${matchId}:${seat}`;
      if (this.running.has(key) || this.service.botSnapshot(matchId, seat) === null) continue;
      this.running.add(key);
      void this.loop(matchId, seat).finally(() => this.running.delete(key));
    }
  }

  get activeLoops(): number {
    return this.running.size;
  }

  stop(): void {
    this.stopped = true;
    for (const key of this.running) this.seats.cancel(key);
  }

  private async loop(matchId: string, seat: SeatId): Promise<void> {
    let conflicts = 0;
    while (!this.stopped) {
      const snapshot = this.service.botSnapshot(matchId, seat);
      if (!snapshot) return;
      let action;
      try {
        action = await this.seats.decide({
          match: snapshot.match,
          seat,
          game: snapshot.game,
          rules: snapshot.rules,
          config: snapshot.config,
          botRng: snapshot.botRng,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "CANCELLED") return;
        this.log.error({ err: error, matchId, seat }, "bot seat decision failed");
        return;
      }
      if (this.stopped) return;
      try {
        if (action.kind === "idle") return;
        if (action.kind === "terminal") {
          await this.service.reconcile(matchId);
          return;
        }
        await this.service.botMove(matchId, seat, {
          commandId: `bot-${seat}-r${snapshot.game.revision}`,
          expectedRevision: snapshot.game.revision,
          direction: action.direction,
        });
        conflicts = 0;
      } catch (error) {
        if (error instanceof AppError && error.code === "REVISION_CONFLICT" && conflicts < 3) {
          conflicts += 1;
          continue;
        }
        if (error instanceof DbBusyError) {
          await delay(100);
          continue;
        }
        this.log.error({ err: error, matchId, seat }, "bot seat move failed");
        return;
      }
      const pause = this.options.moveDelayMs ?? 0;
      await delay(pause);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) setImmediate(resolve);
    else setTimeout(resolve, ms).unref();
  });
}
