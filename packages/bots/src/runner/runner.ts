import { LIMITS } from "@g2048/contracts";
import type {
  BotConfig,
  BotDecision,
  Decimal,
  Direction,
  Exponent,
  GameState,
  RandomState,
  Ruleset,
} from "@g2048/contracts";
import { performance } from "node:perf_hooks";
import { BOT_VERSION, deriveBotRng, difficultyOf, validateBotConfig } from "../choose-move.js";
import type { ChooseMoveResult } from "../choose-move.js";
import { engineAdapter } from "../engine-adapter.js";
import type { EnginePort } from "../engine-port.js";
import type { BotGameEnd } from "../play.js";
import { BotRunnerError, BotWorkerPool } from "./pool.js";
import type { BotPoolErrorCode, BotPoolTask } from "./pool.js";

export { BotRunnerError };

export type BotRunStatus = "queued" | "running" | "paused" | "finished" | "cancelled" | "failed";
export type BotRunnerErrorCode = BotPoolErrorCode;

export type BotRunParams = {
  readonly runId: string;
  readonly config: BotConfig;
  readonly seed: string;
  /** Defaults to `seed`. */
  readonly botSeed?: string;
  readonly rules: Ruleset;
  /** 1..100_000 (CreateBotRunRequest.maxMoves). */
  readonly maxMoves: number;
  /** Start paused so the caller can drive the run with step(). */
  readonly startPaused?: boolean;
  /** Owner of the run (e.g. `user:<id>` / `guest:<id>`) for per-owner caps; opaque to the runner. */
  readonly ownerKey?: string;
};

export type BotRunProgress = {
  readonly runId: string;
  readonly moveIndex: number;
  readonly decision: BotDecision;
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
  readonly latencyMs: number;
  readonly state: GameState;
};

/** Why a run was cancelled: by the caller, its whole-run time limit, or by sitting idle (paused). */
export type BotRunCancelReason = "user" | "wall-clock" | "idle";

export type BotRunResult = {
  readonly runId: string;
  readonly status: "finished" | "cancelled" | "failed";
  readonly cancelReason: BotRunCancelReason | null;
  readonly end: BotGameEnd | "error";
  readonly strategy: BotConfig["strategy"];
  readonly botVersion: string;
  readonly difficulty: ReturnType<typeof difficultyOf>;
  readonly params: BotConfig;
  readonly nodeBudget: number;
  readonly timeBudgetMs: number;
  readonly seed: string;
  readonly botSeed: string;
  readonly rulesetVersion: string;
  readonly moves: readonly Direction[];
  readonly finalScore: Decimal;
  readonly maxExponent: Exponent | null;
  readonly acceptedMoves: number;
  readonly nodesSearched: number;
  readonly fallbackMoves: number;
  readonly decisionLatencyMs: { readonly mean: number; readonly max: number };
  readonly finalState: GameState;
  readonly error?: string;
};

export type BotRunHandle = {
  readonly runId: string;
  readonly status: BotRunStatus;
  /** Pause after the in-flight decision (if any) is applied. */
  pause(): void;
  resume(): void;
  /** While paused: play exactly one move; resolves with it, or null if the run ended. */
  step(): Promise<BotRunProgress | null>;
  /** Abort the in-flight search and resolve the (cancelled) result. */
  cancel(): Promise<BotRunResult>;
  readonly result: Promise<BotRunResult>;
};

export type BotRunnerOptions = {
  /** Max simultaneously active bot-lab runs; default LIMITS.concurrentBotRunsMax. */
  readonly maxConcurrent?: number;
  /** Engine used on the caller's thread to apply moves; defaults to @g2048/engine. */
  readonly enginePort?: EnginePort;
  /** Clock for latency metrics; defaults to performance.now. */
  readonly now?: () => number;
  /**
   * Shared process-wide worker pool (see createBotServices). Bot-lab decisions run as "lab"
   * jobs. When omitted, the runner owns a private pool and shuts it down with itself.
   */
  readonly pool?: BotWorkerPool;
  /** Whole-run wall-clock limit; when it expires the run is cancelled (reason "wall-clock"). Default 30 min. */
  readonly maxWallClockMs?: number;
  /**
   * A run that is paused (or waiting for step()) longer than this is cancelled (reason "idle"), so a
   * forgotten step-mode run cannot hold a run slot forever. Default 10 min.
   */
  readonly idleTimeoutMs?: number;
  /** Max simultaneously active runs per `ownerKey`; default unlimited (only maxConcurrent applies). */
  readonly maxRunsPerOwner?: number;
};

export const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60 * 1000;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs bot-lab games. Every search is a "lab" job on the shared BotWorkerPool (worker_threads),
 * so a slow bot never blocks the caller's event loop and never takes the slots reserved for
 * duel seats. Moves are applied on the caller's thread with the pure engine; workers only
 * decide. Active runs are bounded: start() beyond the limit fails fast with RUNNER_BUSY.
 */
export class BotRunner {
  private readonly runs = new Map<string, BotRun>();
  readonly maxConcurrent: number;
  private readonly port: EnginePort;
  private readonly now: () => number;
  private readonly pool: BotWorkerPool;
  private readonly ownsPool: boolean;
  private readonly limits: { maxWallClockMs: number; idleTimeoutMs: number; maxRunsPerOwner: number | null };

  constructor(options: BotRunnerOptions = {}) {
    const max = options.maxConcurrent ?? LIMITS.concurrentBotRunsMax;
    if (!Number.isSafeInteger(max) || max < 1 || max > LIMITS.concurrentBotRunsMax) {
      throw new BotRunnerError("VALIDATION_ERROR", `maxConcurrent must be 1..${LIMITS.concurrentBotRunsMax}`);
    }
    this.maxConcurrent = max;
    this.port = options.enginePort ?? engineAdapter;
    this.now = options.now ?? (() => performance.now());
    this.ownsPool = options.pool === undefined;
    this.pool = options.pool ?? new BotWorkerPool();
    const positive = (value: number | undefined, fallback: number, name: string): number => {
      const v = value ?? fallback;
      if (!Number.isSafeInteger(v) || v < 1)
        throw new BotRunnerError("VALIDATION_ERROR", `${name} must be >= 1`);
      return v;
    };
    this.limits = {
      maxWallClockMs: positive(options.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS, "maxWallClockMs"),
      idleTimeoutMs: positive(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, "idleTimeoutMs"),
      maxRunsPerOwner:
        options.maxRunsPerOwner === undefined
          ? null
          : positive(options.maxRunsPerOwner, 1, "maxRunsPerOwner"),
    };
  }

  get activeRuns(): number {
    return this.runs.size;
  }

  /** Active runs started with this ownerKey. */
  activeRunsFor(ownerKey: string): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.ownerKey === ownerKey) n += 1;
    return n;
  }

  start(params: BotRunParams, onProgress?: (progress: BotRunProgress) => void): BotRunHandle {
    if (this.runs.has(params.runId))
      throw new BotRunnerError("DUPLICATE_RUN", `run ${params.runId} is active`);
    if (this.runs.size >= this.maxConcurrent) {
      throw new BotRunnerError("RUNNER_BUSY", `at most ${this.maxConcurrent} concurrent bot runs`);
    }
    if (
      params.ownerKey !== undefined &&
      this.limits.maxRunsPerOwner !== null &&
      this.activeRunsFor(params.ownerKey) >= this.limits.maxRunsPerOwner
    ) {
      throw new BotRunnerError(
        "OWNER_LIMIT",
        `at most ${this.limits.maxRunsPerOwner} active bot runs per owner`,
      );
    }
    if (!Number.isSafeInteger(params.maxMoves) || params.maxMoves < 1 || params.maxMoves > 100_000) {
      throw new BotRunnerError("VALIDATION_ERROR", "maxMoves must be an integer in 1..100000");
    }
    const config = validateBotConfig(params.config);
    const run = new BotRun({ ...params, config }, this.pool, this.port, this.now, onProgress, {
      maxWallClockMs: this.limits.maxWallClockMs,
      idleTimeoutMs: this.limits.idleTimeoutMs,
    });
    this.runs.set(params.runId, run);
    void run.result.finally(() => this.runs.delete(params.runId));
    return run;
  }

  /** Cancel every active run (and stop the pool if this runner owns it). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.cancel()));
    if (this.ownsPool) await this.pool.shutdown();
  }
}

class BotRun implements BotRunHandle {
  readonly runId: string;
  readonly result: Promise<BotRunResult>;
  private currentStatus: BotRunStatus = "queued";
  readonly ownerKey: string | undefined;
  private task: BotPoolTask | null = null;
  private cancelRequested = false;
  private cancelReason: BotRunCancelReason | null = null;
  private wallClockTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private wantPaused: boolean;
  private gate: (() => void) | null = null;
  private readonly stepResolvers: ((progress: BotRunProgress | null) => void)[] = [];

  private state: GameState;
  private rng: RandomState;
  private readonly botSeed: string;
  private readonly moves: Direction[] = [];
  private nodes = 0;
  private fallbacks = 0;
  private latencyTotal = 0;
  private latencyMax = 0;

  constructor(
    private readonly params: BotRunParams,
    private readonly pool: BotWorkerPool,
    private readonly port: EnginePort,
    private readonly now: () => number,
    private readonly onProgress: ((progress: BotRunProgress) => void) | undefined,
    private readonly timeouts: { maxWallClockMs: number; idleTimeoutMs: number },
  ) {
    this.runId = params.runId;
    this.ownerKey = params.ownerKey;
    this.wallClockTimer = setTimeout(() => this.abort("wall-clock"), timeouts.maxWallClockMs);
    this.wallClockTimer.unref();
    this.wantPaused = params.startPaused === true;
    this.botSeed = params.botSeed ?? params.seed;
    this.state = port.newGame(params.rules, params.seed);
    this.rng = deriveBotRng(port, this.botSeed);
    this.result = this.loop();
  }

  get status(): BotRunStatus {
    return this.currentStatus;
  }

  pause(): void {
    this.wantPaused = true;
    if (this.currentStatus === "running") this.currentStatus = "paused";
  }

  resume(): void {
    this.wantPaused = false;
    if (this.currentStatus === "paused") this.currentStatus = "running";
    this.openGate();
  }

  step(): Promise<BotRunProgress | null> {
    if (this.isEnded()) return Promise.resolve(null);
    if (!this.wantPaused)
      return Promise.reject(new BotRunnerError("NOT_PAUSED", "step() requires a paused run"));
    return new Promise((resolve) => {
      this.stepResolvers.push(resolve);
      this.openGate();
    });
  }

  async cancel(): Promise<BotRunResult> {
    this.abort("user");
    return this.result;
  }

  private abort(reason: BotRunCancelReason): void {
    if (this.isEnded() || this.cancelRequested) return;
    this.cancelRequested = true;
    this.cancelReason = reason;
    this.task?.cancel(); // aborts the in-flight search at its next node
    this.openGate();
  }

  private isEnded(): boolean {
    return (
      this.currentStatus === "finished" ||
      this.currentStatus === "cancelled" ||
      this.currentStatus === "failed"
    );
  }

  private openGate(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const release = this.gate;
    this.gate = null;
    release?.();
  }

  private async decide(): Promise<ChooseMoveResult> {
    const task = this.pool.submit("lab", {
      state: this.state,
      rules: this.params.rules,
      config: this.params.config,
      botRng: this.rng,
    });
    this.task = task;
    try {
      return (await task.promise).result;
    } finally {
      this.task = null;
    }
  }

  private async loop(): Promise<BotRunResult> {
    let end: BotGameEnd | "error" | null = null;
    let error: string | undefined;
    try {
      await Promise.resolve();
      if (!this.cancelRequested) this.currentStatus = this.wantPaused ? "paused" : "running";
      while (end === null) {
        if (this.cancelRequested) {
          end = "cancelled";
          break;
        }
        if (this.state.status !== "active") {
          const cap = this.params.rules.moveCap;
          end = cap !== null && this.state.acceptedMoves >= cap ? "move-cap" : "dead-board";
          break;
        }
        if (this.moves.length >= this.params.maxMoves) {
          end = "max-moves";
          break;
        }
        if (this.wantPaused && this.stepResolvers.length === 0) {
          this.currentStatus = "paused";
          await new Promise<void>((resolve) => {
            this.gate = resolve;
            // Paused or waiting for step(): an abandoned run is cancelled after idleTimeoutMs.
            this.idleTimer = setTimeout(() => this.abort("idle"), this.timeouts.idleTimeoutMs);
            this.idleTimer.unref();
          });
          continue;
        }
        const stepping = this.wantPaused ? this.stepResolvers.shift() : undefined;
        const started = this.now();
        const result = await this.decide();
        const latency = this.now() - started;
        if (this.cancelRequested) {
          stepping?.(null);
          end = "cancelled";
          break;
        }
        if (result.kind === "no-legal-move") {
          stepping?.(null);
          end = "dead-board";
          break;
        }
        this.rng = result.rng;
        this.nodes += result.decision.nodesSearched;
        if (result.decision.fallback) this.fallbacks += 1;
        this.latencyTotal += latency;
        this.latencyMax = Math.max(this.latencyMax, latency);
        this.state = this.port.applyMove(this.state, result.decision.direction, this.params.rules).state;
        this.moves.push(result.decision.direction);
        const progress: BotRunProgress = {
          runId: this.runId,
          moveIndex: this.moves.length - 1,
          decision: result.decision,
          score: this.state.score,
          maxExponent: this.port.maxExponent(this.state.board),
          acceptedMoves: this.state.acceptedMoves,
          latencyMs: latency,
          state: this.state,
        };
        this.onProgress?.(progress);
        stepping?.(progress);
      }
    } catch (caught) {
      if (this.cancelRequested) {
        end = "cancelled";
      } else {
        end = "error";
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }
    this.currentStatus = end === "cancelled" ? "cancelled" : end === "error" ? "failed" : "finished";
    if (this.wallClockTimer) clearTimeout(this.wallClockTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const resolve of this.stepResolvers.splice(0)) resolve(null);
    const { config } = this.params;
    return {
      runId: this.runId,
      status: this.currentStatus as BotRunResult["status"],
      cancelReason: this.currentStatus === "cancelled" ? (this.cancelReason ?? "user") : null,
      end,
      strategy: config.strategy,
      botVersion: BOT_VERSION,
      difficulty: difficultyOf(config.strategy),
      params: config,
      nodeBudget: config.nodeBudget,
      timeBudgetMs: config.timeBudgetMs,
      seed: this.params.seed,
      botSeed: this.botSeed,
      rulesetVersion: this.params.rules.version,
      moves: this.moves,
      finalScore: this.state.score,
      maxExponent: this.port.maxExponent(this.state.board),
      acceptedMoves: this.state.acceptedMoves,
      nodesSearched: this.nodes,
      fallbackMoves: this.fallbacks,
      decisionLatencyMs: {
        mean: this.moves.length === 0 ? 0 : this.latencyTotal / this.moves.length,
        max: this.latencyMax,
      },
      finalState: this.state,
      ...(error === undefined ? {} : { error }),
    };
  }
}
