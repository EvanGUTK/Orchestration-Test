import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RULESETS,
  practiceRuleset,
  type BotRunView,
  type BotStrategy,
  type CreateBotRunRequest,
  type Ruleset,
} from "@g2048/contracts";
import { BOT_VERSION } from "@g2048/bots";
import {
  BotRunnerError,
  type BotRunHandle,
  type BotRunProgress,
  type BotRunResult,
  type BotServices,
} from "@g2048/bots/runner";
import { competitionRepo, type GameOwnerRef } from "@g2048/database";
import { checksum } from "@g2048/engine";
import { AppError } from "../http/errors.js";
import type { ServiceContext } from "./context.js";
import { nowIso } from "./context.js";
import type { EventBus } from "./event-bus.js";
import type { GameService } from "./game-service.js";
import { FailureRateLimiter } from "./rate-limiter.js";

export type CreateBotRunInput = ReturnType<(typeof CreateBotRunRequest)["parse"]>;

/**
 * Resource limits for bot-lab runs (security gate 4 H2/M3). The first three are enforced by the bot
 * runner (`createBotServices`, see botServicesOptions): a whole run may last at most `maxWallClockMs`,
 * a run left paused (or waiting for step) longer than `idleTimeoutMs` is cancelled, and each owner may
 * have `maxActivePerOwner` active runs. This service keeps the newest `keepRunsPerOwner` finished runs
 * (and their bot games), stores at most `maxPersistedMoves` moves as a replayable game, and allows
 * `startsPerMinute` run starts per client.
 */
export type BotRunLimits = {
  maxWallClockMs: number;
  idleTimeoutMs: number;
  maxActivePerOwner: number;
  keepRunsPerOwner: number;
  maxPersistedMoves: number;
  startsPerMinute: number;
};

export const DEFAULT_BOT_RUN_LIMITS: BotRunLimits = {
  maxWallClockMs: 10 * 60 * 1000,
  idleTimeoutMs: 10 * 60 * 1000,
  maxActivePerOwner: 2,
  keepRunsPerOwner: 50,
  maxPersistedMoves: 2_000,
  startsPerMinute: 20,
};

/** createBotServices() options implementing the runner-side limits. */
export function botServicesOptions(limits: Partial<BotRunLimits> = {}): {
  maxWallClockMs: number;
  idleTimeoutMs: number;
  maxRunsPerOwner: number;
} {
  const l = { ...DEFAULT_BOT_RUN_LIMITS, ...limits };
  return {
    maxWallClockMs: l.maxWallClockMs,
    idleTimeoutMs: l.idleTimeoutMs,
    maxRunsPerOwner: l.maxActivePerOwner,
  };
}

/** BotRunView plus why a cancelled run stopped (`user` | `wall-clock` | `idle`); null otherwise. */
export type BotRunViewWithReason = BotRunView & { cancelReason: "user" | "wall-clock" | "idle" | null };

type LastDecision = NonNullable<BotRunView["lastDecision"]>;

type ActiveRun = {
  id: string;
  owner: GameOwnerRef;
  handle: BotRunHandle;
  input: CreateBotRunInput;
  rules: Ruleset;
  movesPlayed: number;
  lastDecision: LastDecision | null;
  /** Resolves once the final result is persisted; the run is reported terminal only after that. */
  persisted: Promise<void>;
};

function ownsRow(
  owner: GameOwnerRef,
  row: { ownerUserId: string | null; ownerGuestId: string | null },
): boolean {
  return "userId" in owner ? row.ownerUserId === owner.userId : row.ownerGuestId === owner.guestId;
}

function ownsRun(owner: GameOwnerRef, run: ActiveRun): boolean {
  if ("userId" in owner) return "userId" in run.owner && run.owner.userId === owner.userId;
  return "guestId" in run.owner && run.owner.guestId === owner.guestId;
}

function mapRunnerError(error: unknown): unknown {
  if (!(error instanceof BotRunnerError)) return error;
  switch (error.code) {
    case "RUNNER_BUSY":
      return new AppError("RESOURCE_LIMIT", "Too many bot runs are active; cancel one or try again later");
    case "OWNER_LIMIT":
      return new AppError("RESOURCE_LIMIT", "Too many active bot runs for this profile; cancel one first");
    case "NOT_PAUSED":
      return new AppError("VALIDATION_ERROR", "Pause the run before stepping it");
    case "VALIDATION_ERROR":
      return new AppError("VALIDATION_ERROR", error.message);
    default:
      return new AppError("FORBIDDEN", error.message);
  }
}

/**
 * Bot laboratory runs (BOT-01/02, CONTRACT-001 C13). Searches run in the shared worker pool
 * (@g2048/bots/runner) so a slow bot never blocks the API (OPS-06). Each run is persisted in
 * `bot_runs` (strategy, version, config, budgets, seed, status, metrics). When a bot-v1 run ends, its
 * moves (up to `maxPersistedMoves`) are re-applied through the authoritative transition into a
 * `bot-exhibition` game owned by the requester (replayable, never ranked, never on human boards).
 * Runs in flight when the server stopped are marked cancelled at the next start. See BotRunLimits.
 */
export class BotRunService {
  readonly #ctx: ServiceContext;
  readonly #games: GameService;
  readonly #bots: BotServices;
  readonly #events: EventBus | null;
  readonly #limits: BotRunLimits;
  readonly #starts: FailureRateLimiter;
  readonly #active = new Map<string, ActiveRun>();

  constructor(
    ctx: ServiceContext,
    games: GameService,
    bots: BotServices,
    events: EventBus | null = null,
    limits: Partial<BotRunLimits> = {},
  ) {
    this.#ctx = ctx;
    this.#games = games;
    this.#bots = bots;
    this.#events = events;
    this.#limits = { ...DEFAULT_BOT_RUN_LIMITS, ...limits };
    this.#starts = new FailureRateLimiter({
      limit: this.#limits.startsPerMinute,
      windowMs: 60_000,
      now: () => ctx.clock().getTime(),
    });
  }

  /** Boot step (inside the caller's transaction): in-flight runs from a previous process are cancelled. */
  recoverInterruptedInTransaction(db: DatabaseSync): number {
    return competitionRepo.cancelInterruptedBotRuns(db, nowIso(this.#ctx));
  }

  /** For the realtime hub (gate 4 L6): may `owner` see events of bot run `id`? */
  canView(owner: GameOwnerRef, id: string): boolean {
    const run = this.#active.get(id);
    if (run) return ownsRun(owner, run);
    const row = competitionRepo.getBotRun(this.#ctx.db, id);
    return row !== null && ownsRow(owner, row);
  }

  async start(
    owner: GameOwnerRef,
    input: CreateBotRunInput,
    clientKey: string,
  ): Promise<BotRunViewWithReason> {
    const decision = this.#starts.reserve(`bot-start:${clientKey}`);
    if (!decision.allowed) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      throw new AppError(
        "RATE_LIMITED",
        "Too many bot runs started; try again later",
        { retryAfterSeconds: seconds },
        {
          "retry-after": String(seconds),
        },
      );
    }
    const id = randomUUID();
    const rules: Ruleset = input.practice
      ? practiceRuleset({
          size: input.practice.size,
          fourWeight: input.practice.fourWeight,
          undo: input.practice.undo,
        })
      : RULESETS["bot-v1"];
    const config = {
      strategy: input.strategy,
      nodeBudget: input.nodeBudget,
      timeBudgetMs: input.timeBudgetMs,
    };
    let handle: BotRunHandle;
    try {
      handle = this.#bots.runner.start(
        {
          runId: id,
          config,
          seed: input.seed,
          rules,
          maxMoves: input.maxMoves,
          startPaused: input.stepMode,
          // Per-owner active-run cap, wall-clock and idle limits are enforced by the runner.
          ownerKey: "userId" in owner ? `user:${owner.userId}` : `guest:${owner.guestId}`,
        },
        (progress) => this.#onProgress(id, progress),
      );
    } catch (error) {
      throw mapRunnerError(error);
    }
    // Queued before the result can be persisted (FIFO writer), so the row always exists first.
    const inserted = this.#ctx.writer.run((db) =>
      competitionRepo.insertBotRun(db, {
        id,
        ownerUserId: "userId" in owner ? owner.userId : null,
        ownerGuestId: "guestId" in owner ? owner.guestId : null,
        strategy: input.strategy,
        botVersion: BOT_VERSION,
        configJson: JSON.stringify({ ...config, maxMoves: input.maxMoves, stepMode: input.stepMode, rules }),
        nodeBudget: input.nodeBudget,
        timeBudgetMs: input.timeBudgetMs,
        seed: input.seed,
        status: input.stepMode ? "paused" : "running",
        now: nowIso(this.#ctx),
      }),
    );
    const run: ActiveRun = {
      id,
      owner,
      handle,
      input,
      rules,
      movesPlayed: 0,
      lastDecision: null,
      persisted: Promise.resolve(),
    };
    run.persisted = handle.result
      .then((result) => this.#persist(run, result))
      .finally(() => this.#active.delete(id));
    this.#active.set(id, run);
    try {
      await inserted;
    } catch (error) {
      await handle.cancel();
      throw error;
    }
    return this.#activeView(run);
  }

  view(owner: GameOwnerRef, id: string): BotRunViewWithReason {
    const run = this.#active.get(id);
    if (run) {
      if (!ownsRun(owner, run)) throw new AppError("NOT_FOUND", "Bot run not found");
      return this.#activeView(run);
    }
    const row = competitionRepo.getBotRun(this.#ctx.db, id);
    if (!row || !ownsRow(owner, row)) throw new AppError("NOT_FOUND", "Bot run not found");
    const metrics = JSON.parse(row.metricsJson) as {
      lastDecision?: LastDecision | null;
      cancelReason?: BotRunViewWithReason["cancelReason"];
    };
    return {
      id: row.id,
      strategy: row.strategy as BotStrategy,
      botVersion: row.botVersion,
      status: row.status as BotRunView["status"],
      gameId: row.gameId,
      nodeBudget: row.nodeBudget,
      timeBudgetMs: row.timeBudgetMs,
      seed: row.seed,
      movesPlayed: row.movesPlayed,
      lastDecision: metrics.lastDecision ?? null,
      cancelReason: row.status === "cancelled" ? (metrics.cancelReason ?? null) : null,
    };
  }

  /** Idempotent: cancelling a finished or cancelled run returns its final view. */
  async cancel(owner: GameOwnerRef, id: string): Promise<BotRunViewWithReason> {
    const run = this.#owned(owner, id);
    if (run) {
      await run.handle.cancel();
      await run.persisted;
    }
    return this.view(owner, id);
  }

  async pause(owner: GameOwnerRef, id: string): Promise<BotRunViewWithReason> {
    const run = this.#owned(owner, id);
    if (run) {
      run.handle.pause();
      await this.#ctx.writer.run((db) =>
        competitionRepo.updateActiveBotRunStatus(db, run.id, "paused", nowIso(this.#ctx)),
      );
    }
    return this.view(owner, id);
  }

  async resume(owner: GameOwnerRef, id: string): Promise<BotRunViewWithReason> {
    const run = this.#owned(owner, id);
    if (run) {
      run.handle.resume();
      await this.#ctx.writer.run((db) =>
        competitionRepo.updateActiveBotRunStatus(db, run.id, "running", nowIso(this.#ctx)),
      );
    }
    return this.view(owner, id);
  }

  async step(owner: GameOwnerRef, id: string): Promise<BotRunViewWithReason> {
    const run = this.#owned(owner, id);
    if (run) {
      try {
        await run.handle.step();
      } catch (error) {
        throw mapRunnerError(error);
      }
    }
    return this.view(owner, id);
  }

  /** Cancels every active run and waits until each final result is persisted. */
  async shutdown(): Promise<void> {
    const pending = [...this.#active.values()].map((run) => run.persisted);
    await this.#bots.shutdown();
    await Promise.allSettled(pending);
  }

  #owned(owner: GameOwnerRef, id: string): ActiveRun | null {
    const run = this.#active.get(id);
    if (run) {
      if (!ownsRun(owner, run)) throw new AppError("NOT_FOUND", "Bot run not found");
      return run;
    }
    const row = competitionRepo.getBotRun(this.#ctx.db, id);
    if (!row || !ownsRow(owner, row)) throw new AppError("NOT_FOUND", "Bot run not found");
    return null; // terminal: commands are no-ops that return the final view
  }

  #activeView(run: ActiveRun): BotRunViewWithReason {
    const status = run.handle.status;
    // Until the result is persisted (game recorded) the run is still reported as running.
    const reported: BotRunView["status"] =
      status === "finished" || status === "cancelled" || status === "failed" ? "running" : status;
    return {
      id: run.id,
      strategy: run.input.strategy,
      botVersion: BOT_VERSION,
      status: reported,
      gameId: null,
      nodeBudget: run.input.nodeBudget,
      timeBudgetMs: run.input.timeBudgetMs,
      seed: run.input.seed,
      movesPlayed: run.movesPlayed,
      lastDecision: run.lastDecision,
      cancelReason: null,
    };
  }

  #onProgress(id: string, progress: BotRunProgress): void {
    const run = this.#active.get(id);
    if (!run) return;
    run.movesPlayed = progress.acceptedMoves;
    run.lastDecision = {
      direction: progress.decision.direction,
      explanation: progress.decision.explanation,
      nodesSearched: progress.decision.nodesSearched,
      fallback: progress.decision.fallback,
    };
    this.#events?.publishNow({
      type: "bot.progress",
      resourceId: id,
      sequence: progress.moveIndex + 1,
      payload: { movesPlayed: run.movesPlayed, score: progress.score, lastDecision: run.lastDecision },
    });
  }

  async #persist(run: ActiveRun, result: BotRunResult): Promise<void> {
    const persistGame =
      result.status !== "failed" &&
      run.rules.version === RULESETS["bot-v1"].version &&
      result.moves.length > 0 &&
      result.moves.length <= this.#limits.maxPersistedMoves;
    const metrics = {
      end: result.end,
      difficulty: result.difficulty,
      finalScore: result.finalScore,
      maxExponent: result.maxExponent,
      acceptedMoves: result.acceptedMoves,
      nodesSearched: result.nodesSearched,
      fallbackMoves: result.fallbackMoves,
      decisionLatencyMs: result.decisionLatencyMs,
      lastDecision: run.lastDecision,
      ...(result.cancelReason ? { cancelReason: result.cancelReason } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(persistGame ? {} : { gameNotStored: true }),
    };
    try {
      await this.#ctx.writer.run((db) => {
        let gameId: string | null = null;
        let status: string = result.status;
        if (persistGame) {
          const game = this.#games.recordBotGameInTransaction(db, run.owner, {
            rules: run.rules,
            seed: run.input.seed,
            directions: result.moves,
          });
          if (checksum(game.state) !== checksum(result.finalState))
            status = "failed"; // never store a mismatch silently
          else gameId = game.id;
        }
        competitionRepo.updateBotRun(db, run.id, {
          status,
          movesPlayed: result.acceptedMoves,
          metricsJson: JSON.stringify(metrics),
          gameId,
          now: nowIso(this.#ctx),
        });
        competitionRepo.pruneBotRuns(db, run.owner, this.#limits.keepRunsPerOwner);
        this.#events?.publishAfterCommit({
          type: "bot.finished",
          resourceId: run.id,
          sequence: result.acceptedMoves + 1,
          payload: { status, gameId, movesPlayed: result.acceptedMoves, finalScore: result.finalScore },
        });
      });
    } catch {
      // Could not record the result (e.g. writer busy or closing): never leave the row "running".
      try {
        await this.#ctx.writer.run((db) =>
          competitionRepo.updateActiveBotRunStatus(db, run.id, "failed", nowIso(this.#ctx)),
        );
      } catch {
        // writer closed: the next start marks the row cancelled (recoverInterrupted)
      }
    }
  }
}
