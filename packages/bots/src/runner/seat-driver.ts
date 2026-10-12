import { LIMITS } from "@g2048/contracts";
import type { BotConfig, GameState, RandomState, Ruleset, SeatId } from "@g2048/contracts";
import type { MatchState } from "@g2048/competition";
import { Worker } from "node:worker_threads";
import { validateBotConfig } from "../choose-move.js";
import { engineAdapter } from "../engine-adapter.js";
import type { EnginePort } from "../engine-port.js";
import { planBotSeat } from "../seat-driver.js";
import type { BotSeatAction } from "../seat-driver.js";
import type { BotWorkerData, ChooseRequest, WorkerReply } from "./protocol.js";
import { BotRunnerError } from "./runner.js";
import { WORKER_EXEC_ARGV, WORKER_URL } from "./worker-url.js";

export type BotSeatRequest = {
  readonly match: MatchState;
  readonly seat: SeatId;
  readonly game: GameState;
  readonly rules: Ruleset;
  readonly config: BotConfig;
  readonly botRng: RandomState;
};

export type BotSeatDriverOptions = {
  /** Worker threads in the pool; default LIMITS.concurrentBotRunsMax. */
  readonly workers?: number;
  /** Max decisions waiting for a free worker; beyond it decide() rejects RUNNER_BUSY. */
  readonly queueMax?: number;
  readonly enginePort?: EnginePort;
};

type Job = {
  readonly key: string;
  readonly request: ChooseRequest;
  readonly resolve: (action: BotSeatAction) => void;
  readonly reject: (error: Error) => void;
  readonly seat: SeatId;
  cancelled: boolean;
};

type Slot = { worker: Worker; flag: Int32Array; ready: Promise<void>; job: Job | null };

/**
 * Async bot-seat driver for the server (human-vs-bot and bot-vs-bot matches).
 *
 * decide() first runs planBotSeat on the caller's thread (cheap, no search). Only "decide"
 * plans go to a fixed pool of worker_threads, so searches never run on the API event loop and a
 * slow bot seat cannot delay a human seat or another match. Each seat key (`matchId:seat`)
 * has at most one decision in flight. cancel(key) or an AbortSignal aborts the search through a
 * shared flag and rejects with CANCELLED, so a cancelled decision is never applied.
 */
export class BotSeatDriver {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<string, Job>();
  private readonly port: EnginePort;
  readonly workers: number;
  readonly queueMax: number;
  private nextId = 1;
  private closed = false;

  constructor(options: BotSeatDriverOptions = {}) {
    this.workers = options.workers ?? LIMITS.concurrentBotRunsMax;
    this.queueMax = options.queueMax ?? 64;
    if (
      !Number.isSafeInteger(this.workers) ||
      this.workers < 1 ||
      this.workers > LIMITS.concurrentBotRunsMax
    ) {
      throw new BotRunnerError("VALIDATION_ERROR", `workers must be 1..${LIMITS.concurrentBotRunsMax}`);
    }
    if (!Number.isSafeInteger(this.queueMax) || this.queueMax < 0) {
      throw new BotRunnerError("VALIDATION_ERROR", "queueMax must be a non-negative integer");
    }
    this.port = options.enginePort ?? engineAdapter;
  }

  /** Decisions currently searching or queued. */
  get pending(): number {
    return this.inFlight.size;
  }

  decide(request: BotSeatRequest, options: { signal?: AbortSignal } = {}): Promise<BotSeatAction> {
    if (this.closed) return Promise.reject(new BotRunnerError("VALIDATION_ERROR", "driver is shut down"));
    let plan;
    try {
      plan = planBotSeat(request.match, request.seat, request.game, this.port);
      validateBotConfig(request.config);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (plan.kind !== "decide") return Promise.resolve(plan);
    const key = `${request.match.id}:${request.seat}`;
    if (this.inFlight.has(key)) {
      return Promise.reject(
        new BotRunnerError("DUPLICATE_RUN", `seat ${key} already has a decision in flight`),
      );
    }
    const busySlots = this.slots.filter((s) => s.job !== null).length;
    if (busySlots >= this.workers && this.queue.length >= this.queueMax) {
      return Promise.reject(new BotRunnerError("RUNNER_BUSY", "bot decision queue is full"));
    }
    if (options.signal?.aborted === true) return Promise.reject(cancelledError(key));

    return new Promise<BotSeatAction>((resolve, reject) => {
      const job: Job = {
        key,
        seat: request.seat,
        cancelled: false,
        request: {
          type: "choose",
          id: this.nextId++,
          state: request.game,
          rules: request.rules,
          config: request.config,
          botRng: request.botRng,
        },
        resolve,
        reject,
      };
      this.inFlight.set(key, job);
      options.signal?.addEventListener("abort", () => this.cancel(key), { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  /** Abort the decision for `matchId:seat`, if any. Returns whether something was cancelled. */
  cancel(key: string): boolean {
    const job = this.inFlight.get(key);
    if (job === undefined) return false;
    job.cancelled = true;
    this.inFlight.delete(key);
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    const slot = this.slots.find((s) => s.job === job);
    if (slot !== undefined) Atomics.store(slot.flag, 0, 1);
    job.reject(cancelledError(key));
    return true;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const key of [...this.inFlight.keys()]) this.cancel(key);
    await Promise.all(this.slots.splice(0).map((s) => s.worker.terminate()));
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => s.job === null);
      if (slot === undefined && this.slots.length < this.workers) slot = this.spawn();
      if (slot === undefined) return;
      const job = this.queue.shift() as Job;
      this.run(slot, job);
    }
  }

  private spawn(): Slot {
    const cancelBuffer = new SharedArrayBuffer(4);
    const worker = new Worker(WORKER_URL, {
      workerData: { cancelBuffer } satisfies BotWorkerData,
      execArgv: WORKER_EXEC_ARGV,
    });
    worker.unref();
    const ready = new Promise<void>((resolve, reject) => {
      worker.once("message", (m: WorkerReply) => (m.type === "ready" ? resolve() : undefined));
      worker.once("error", reject);
    });
    ready.catch(() => undefined);
    const slot: Slot = { worker, flag: new Int32Array(cancelBuffer), ready, job: null };
    worker.on("message", (reply: WorkerReply) => this.onReply(slot, reply));
    const onDeath = (error: Error): void => {
      const job = slot.job;
      slot.job = null;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      if (job !== null && !job.cancelled) {
        this.inFlight.delete(job.key);
        job.reject(error);
      }
      if (!this.closed) this.pump();
    };
    worker.on("error", onDeath);
    worker.on("exit", (code) => onDeath(new Error(`bot worker exited with code ${code}`)));
    this.slots.push(slot);
    return slot;
  }

  private run(slot: Slot, job: Job): void {
    slot.job = job;
    Atomics.store(slot.flag, 0, 0);
    slot.ready.then(
      () => {
        if (slot.job === job) slot.worker.postMessage(job.request);
      },
      () => undefined,
    );
  }

  private onReply(slot: Slot, reply: WorkerReply): void {
    if (reply.type === "ready") return;
    const job = slot.job;
    if (job === null || reply.id !== job.request.id) return;
    slot.job = null;
    Atomics.store(slot.flag, 0, 0);
    if (!job.cancelled) {
      this.inFlight.delete(job.key);
      if (reply.type === "error") job.reject(new Error(reply.message));
      else if (reply.result.kind === "no-legal-move") {
        job.resolve({
          kind: "terminal",
          command: {
            type: "seat-terminal",
            seat: job.seat,
            reason: "dead-board",
            score: job.request.state.score,
            maxExponent: this.port.maxExponent(job.request.state.board),
            acceptedMoves: job.request.state.acceptedMoves,
          },
        });
      } else {
        const { decision, rng } = reply.result;
        job.resolve({ kind: "move", direction: decision.direction, decision, rng });
      }
    }
    this.pump();
  }
}

function cancelledError(key: string): BotRunnerError {
  return new BotRunnerError("CANCELLED", `bot decision for ${key} was cancelled`);
}
