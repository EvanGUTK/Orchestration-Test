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

export type CreateBotRunInput = ReturnType<(typeof CreateBotRunRequest)["parse"]>;

/** Bot games longer than this are not stored as replayable games (keeps the writer responsive). */
export const MAX_PERSISTED_BOT_MOVES = 5_000;

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

function mapRunnerError(error: unknown): unknown {
  if (!(error instanceof BotRunnerError)) return error;
  switch (error.code) {
    case "RUNNER_BUSY":
      return new AppError("RESOURCE_LIMIT", "Too many bot runs are active; cancel one or try again later");
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
 * moves are re-applied through the authoritative transition into a `bot-exhibition` game owned by the
 * requester (replayable, never ranked, never counted on human boards). Runs that were in flight when
 * the server stopped are marked cancelled at the next start, never counted as results.
 */
export class BotRunService {
  readonly #ctx: ServiceContext;
  readonly #games: GameService;
  readonly #bots: BotServices;
  readonly #events: EventBus | null;
  readonly #active = new Map<string, ActiveRun>();

  constructor(ctx: ServiceContext, games: GameService, bots: BotServices, events: EventBus | null = null) {
    this.#ctx = ctx;
    this.#games = games;
    this.#bots = bots;
    this.#events = events;
  }

  /** Boot step (inside the caller's transaction): in-flight runs from a previous process are cancelled. */
  recoverInterruptedInTransaction(db: DatabaseSync): number {
    return competitionRepo.cancelInterruptedBotRuns(db, nowIso(this.#ctx));
  }

  async start(owner: GameOwnerRef, input: CreateBotRunInput): Promise<BotRunView> {
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
        { runId: id, config, seed: input.seed, rules, maxMoves: input.maxMoves, startPaused: input.stepMode },
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

  view(owner: GameOwnerRef, id: string): BotRunView {
    const run = this.#active.get(id);
    if (run) {
      if (!ownsRun(owner, run)) throw new AppError("NOT_FOUND", "Bot run not found");
      return this.#activeView(run);
    }
    const row = competitionRepo.getBotRun(this.#ctx.db, id);
    if (!row || !ownsRow(owner, row)) throw new AppError("NOT_FOUND", "Bot run not found");
    const metrics = JSON.parse(row.metricsJson) as { lastDecision?: LastDecision | null };
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
    };
  }

  /** Idempotent: cancelling a finished or cancelled run returns its final view. */
  async cancel(owner: GameOwnerRef, id: string): Promise<BotRunView> {
    const run = this.#owned(owner, id);
    if (run) {
      await run.handle.cancel();
      await run.persisted;
    }
    return this.view(owner, id);
  }

  async pause(owner: GameOwnerRef, id: string): Promise<BotRunView> {
    const run = this.#owned(owner, id);
    if (run) {
      run.handle.pause();
      await this.#ctx.writer.run((db) => this.#saveStatus(db, run, "paused"));
    }
    return this.view(owner, id);
  }

  async resume(owner: GameOwnerRef, id: string): Promise<BotRunView> {
    const run = this.#owned(owner, id);
    if (run) {
      run.handle.resume();
      await this.#ctx.writer.run((db) => this.#saveStatus(db, run, "running"));
    }
    return this.view(owner, id);
  }

  async step(owner: GameOwnerRef, id: string): Promise<BotRunView> {
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

  #activeView(run: ActiveRun): BotRunView {
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

  #saveStatus(db: DatabaseSync, run: ActiveRun, status: string): void {
    competitionRepo.updateBotRun(db, run.id, {
      status,
      movesPlayed: run.movesPlayed,
      metricsJson: JSON.stringify({ lastDecision: run.lastDecision }),
      now: nowIso(this.#ctx),
    });
  }

  async #persist(run: ActiveRun, result: BotRunResult): Promise<void> {
    const persistGame =
      result.status !== "failed" &&
      run.rules.version === RULESETS["bot-v1"].version &&
      result.moves.length > 0 &&
      result.moves.length <= MAX_PERSISTED_BOT_MOVES;
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
        this.#events?.publishAfterCommit({
          type: "bot.finished",
          resourceId: run.id,
          sequence: result.acceptedMoves + 1,
          payload: { status, gameId, movesPlayed: result.acceptedMoves, finalScore: result.finalScore },
        });
      });
    } catch {
      // The writer is closing or busy: leave the row as-is; the next start marks it cancelled.
    }
  }
}

function ownsRun(owner: GameOwnerRef, run: ActiveRun): boolean {
  if ("userId" in owner) return "userId" in run.owner && run.owner.userId === owner.userId;
  return "guestId" in run.owner && run.owner.guestId === owner.guestId;
}
