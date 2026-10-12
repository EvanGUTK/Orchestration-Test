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
import { Worker } from "node:worker_threads";
import { BOT_VERSION, deriveBotRng, difficultyOf, validateBotConfig } from "../choose-move.js";
import type { ChooseMoveResult } from "../choose-move.js";
import { engineAdapter } from "../engine-adapter.js";
import type { EnginePort } from "../engine-port.js";
import type { BotGameEnd } from "../play.js";
import type { BotWorkerData, ChooseRequest, WorkerReply } from "./protocol.js";
import { WORKER_EXEC_ARGV, WORKER_URL } from "./worker-url.js";

export type BotRunStatus = "queued" | "running" | "paused" | "finished" | "cancelled" | "failed";
export type BotRunnerErrorCode =
  "RUNNER_BUSY" | "DUPLICATE_RUN" | "NOT_PAUSED" | "CANCELLED" | "VALIDATION_ERROR";

export class BotRunnerError extends Error {
  readonly code: BotRunnerErrorCode;

  constructor(code: BotRunnerErrorCode, message: string) {
    super(message);
    this.name = "BotRunnerError";
    this.code = code;
  }
}

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

export type BotRunResult = {
  readonly runId: string;
  readonly status: "finished" | "cancelled" | "failed";
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
  /** Abort the in-flight search, stop the worker, and resolve the (cancelled) result. */
  cancel(): Promise<BotRunResult>;
  readonly result: Promise<BotRunResult>;
};

export type BotRunnerOptions = {
  /** Max simultaneously running bot workers; default LIMITS.concurrentBotRunsMax. */
  readonly maxConcurrent?: number;
  /** Engine used on the caller's thread to apply moves; defaults to @g2048/engine. */
  readonly enginePort?: EnginePort;
  /** Clock for latency metrics; defaults to performance.now. */
  readonly now?: () => number;
};

/**
 * Runs bot games with every search in a dedicated worker_threads worker, so a slow bot
 * never blocks the caller's event loop. Moves are applied on the caller's thread with the
 * pure engine; the worker only decides. Concurrency is bounded: start() beyond the limit
 * fails fast with RUNNER_BUSY (explicit busy response, no unbounded queue).
 */
export class BotRunner {
  private readonly runs = new Map<string, BotRun>();
  readonly maxConcurrent: number;
  private readonly port: EnginePort;
  private readonly now: () => number;

  constructor(options: BotRunnerOptions = {}) {
    const max = options.maxConcurrent ?? LIMITS.concurrentBotRunsMax;
    if (!Number.isSafeInteger(max) || max < 1 || max > LIMITS.concurrentBotRunsMax) {
      throw new BotRunnerError("VALIDATION_ERROR", `maxConcurrent must be 1..${LIMITS.concurrentBotRunsMax}`);
    }
    this.maxConcurrent = max;
    this.port = options.enginePort ?? engineAdapter;
    this.now = options.now ?? (() => performance.now());
  }

  get activeRuns(): number {
    return this.runs.size;
  }

  start(params: BotRunParams, onProgress?: (progress: BotRunProgress) => void): BotRunHandle {
    if (this.runs.has(params.runId))
      throw new BotRunnerError("DUPLICATE_RUN", `run ${params.runId} is active`);
    if (this.runs.size >= this.maxConcurrent) {
      throw new BotRunnerError("RUNNER_BUSY", `at most ${this.maxConcurrent} concurrent bot runs`);
    }
    if (!Number.isSafeInteger(params.maxMoves) || params.maxMoves < 1 || params.maxMoves > 100_000) {
      throw new BotRunnerError("VALIDATION_ERROR", "maxMoves must be an integer in 1..100000");
    }
    const config = validateBotConfig(params.config);
    const run = new BotRun({ ...params, config }, this.port, this.now, onProgress);
    this.runs.set(params.runId, run);
    void run.result.finally(() => this.runs.delete(params.runId));
    return run;
  }

  /** Cancel every active run. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.cancel()));
  }
}

type Pending = { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void };

class BotRun implements BotRunHandle {
  readonly runId: string;
  readonly result: Promise<BotRunResult>;
  private currentStatus: BotRunStatus = "queued";
  private readonly worker: Worker;
  private readonly cancelFlag: Int32Array;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private cancelRequested = false;
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
    private readonly port: EnginePort,
    private readonly now: () => number,
    private readonly onProgress: ((progress: BotRunProgress) => void) | undefined,
  ) {
    this.runId = params.runId;
    this.wantPaused = params.startPaused === true;
    this.botSeed = params.botSeed ?? params.seed;
    this.state = port.newGame(params.rules, params.seed);
    this.rng = deriveBotRng(port, this.botSeed);
    const cancelBuffer = new SharedArrayBuffer(4);
    this.cancelFlag = new Int32Array(cancelBuffer);
    this.worker = new Worker(WORKER_URL, {
      workerData: { cancelBuffer } satisfies BotWorkerData,
      execArgv: WORKER_EXEC_ARGV,
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (message: WorkerReply): void => {
        if (message.type === "ready") resolve();
      };
      this.worker.once("message", onReady);
      this.worker.once("error", reject);
      this.worker.once("exit", (code) => reject(new Error(`bot worker exited with code ${code}`)));
    });
    this.worker.on("message", (reply: WorkerReply) => {
      if (reply.type === "ready") return;
      const pending = this.pending.get(reply.id);
      if (pending === undefined) return;
      this.pending.delete(reply.id);
      pending.resolve(reply);
    });
    const failAll = (error: Error): void => {
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
    this.worker.on("error", failAll);
    this.worker.on("exit", (code) => failAll(new Error(`bot worker exited with code ${code}`)));
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
    if (!this.isEnded()) {
      this.cancelRequested = true;
      Atomics.store(this.cancelFlag, 0, 1); // aborts the in-flight search at its next node
      this.openGate();
      await this.worker.terminate();
    }
    return this.result;
  }

  private isEnded(): boolean {
    return (
      this.currentStatus === "finished" ||
      this.currentStatus === "cancelled" ||
      this.currentStatus === "failed"
    );
  }

  private openGate(): void {
    const release = this.gate;
    this.gate = null;
    release?.();
  }

  private request(): Promise<WorkerReply> {
    const id = this.nextId;
    this.nextId += 1;
    const message: ChooseRequest = {
      type: "choose",
      id,
      state: this.state,
      rules: this.params.rules,
      config: this.params.config,
      botRng: this.rng,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(message);
    });
  }

  private async loop(): Promise<BotRunResult> {
    let end: BotGameEnd | "error" | null = null;
    let error: string | undefined;
    try {
      await this.ready;
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
          });
          continue;
        }
        const stepping = this.wantPaused ? this.stepResolvers.shift() : undefined;
        const started = this.now();
        const reply = await this.request();
        const latency = this.now() - started;
        if (this.cancelRequested) {
          stepping?.(null);
          end = "cancelled";
          break;
        }
        if (reply.type === "error") throw new Error(reply.message);
        if (reply.type !== "result") continue;
        const result: ChooseMoveResult = reply.result;
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
    for (const resolve of this.stepResolvers.splice(0)) resolve(null);
    await this.worker.terminate();
    const { config } = this.params;
    return {
      runId: this.runId,
      status: this.currentStatus as BotRunResult["status"],
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
