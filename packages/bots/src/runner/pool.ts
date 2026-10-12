import { LIMITS } from "@g2048/contracts";
import type { BotConfig, GameState, RandomState, Ruleset } from "@g2048/contracts";
import { Worker } from "node:worker_threads";
import type { ChooseMoveResult } from "../choose-move.js";
import type { BotWorkerData, ChooseRequest, WorkerReply } from "./protocol.js";
import { WORKER_EXEC_ARGV, WORKER_URL } from "./worker-url.js";

export type BotPoolErrorCode =
  "RUNNER_BUSY" | "DUPLICATE_RUN" | "NOT_PAUSED" | "CANCELLED" | "VALIDATION_ERROR";

export class BotRunnerError extends Error {
  readonly code: BotPoolErrorCode;

  constructor(code: BotPoolErrorCode, message: string) {
    super(message);
    this.name = "BotRunnerError";
    this.code = code;
  }
}

/** "seat": interactive duel seats (never starved). "lab": bot-lab runs and other batch work. */
export type BotJobPriority = "seat" | "lab";

export type BotDecisionInput = {
  readonly state: GameState;
  readonly rules: Ruleset;
  readonly config: BotConfig;
  readonly botRng: RandomState;
};

export type BotDecisionOutput = { readonly result: ChooseMoveResult; readonly elapsedMs: number };

export type BotPoolTask = {
  readonly promise: Promise<BotDecisionOutput>;
  /** Removes a queued job or aborts a running search; the promise rejects with CANCELLED. */
  cancel(): void;
};

export type BotWorkerPoolOptions = {
  /** Total worker threads in the process; default and maximum LIMITS.concurrentBotRunsMax (8). */
  readonly size?: number;
  /**
   * Slots lab jobs may never occupy, so seats always find a worker. Default min(2, size - 1),
   * so lab work keeps at least one slot. reservedSeatSlots = size makes a seat-only pool.
   */
  readonly reservedSeatSlots?: number;
  /** Bounded wait queues per priority; default 64 each. */
  readonly seatQueueMax?: number;
  readonly labQueueMax?: number;
};

export type BotPoolStats = {
  readonly size: number;
  readonly reservedSeatSlots: number;
  readonly workers: number;
  readonly busySeat: number;
  readonly busyLab: number;
  readonly queuedSeat: number;
  readonly queuedLab: number;
};

type Job = {
  readonly priority: BotJobPriority;
  readonly request: ChooseRequest;
  readonly resolve: (out: BotDecisionOutput) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
};

type Slot = { worker: Worker; flag: Int32Array; ready: Promise<void>; job: Job | null };

/**
 * The single process-wide bot worker pool. Every bot search in the server (bot-lab runs and
 * duel bot seats) runs here, so the total number of bot threads never exceeds `size`
 * (LIMITS.concurrentBotRunsMax).
 *
 * Fairness: seat jobs are always dispatched before lab jobs, and lab jobs may occupy at most
 * `size - reservedSeatSlots` workers. A seat therefore never waits behind queued lab work, and
 * at least `reservedSeatSlots` workers are always free of lab searches. Within a priority the
 * order is FIFO. Both queues are bounded (RUNNER_BUSY). Searches never run on the caller's
 * event loop.
 */
export class BotWorkerPool {
  readonly size: number;
  readonly reservedSeatSlots: number;
  private readonly seatQueueMax: number;
  private readonly labQueueMax: number;
  private readonly slots: Slot[] = [];
  private readonly seatQueue: Job[] = [];
  private readonly labQueue: Job[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: BotWorkerPoolOptions = {}) {
    this.size = options.size ?? LIMITS.concurrentBotRunsMax;
    this.reservedSeatSlots = options.reservedSeatSlots ?? Math.min(2, Math.max(0, this.size - 1));
    this.seatQueueMax = options.seatQueueMax ?? 64;
    this.labQueueMax = options.labQueueMax ?? 64;
    if (!Number.isSafeInteger(this.size) || this.size < 1 || this.size > LIMITS.concurrentBotRunsMax) {
      throw new BotRunnerError("VALIDATION_ERROR", `size must be 1..${LIMITS.concurrentBotRunsMax}`);
    }
    if (
      !Number.isSafeInteger(this.reservedSeatSlots) ||
      this.reservedSeatSlots < 0 ||
      this.reservedSeatSlots > this.size
    ) {
      throw new BotRunnerError("VALIDATION_ERROR", "reservedSeatSlots must be 0..size");
    }
    for (const q of [this.seatQueueMax, this.labQueueMax]) {
      if (!Number.isSafeInteger(q) || q < 0)
        throw new BotRunnerError("VALIDATION_ERROR", "queue bounds must be >= 0");
    }
  }

  stats(): BotPoolStats {
    return {
      size: this.size,
      reservedSeatSlots: this.reservedSeatSlots,
      workers: this.slots.length,
      busySeat: this.slots.filter((s) => s.job?.priority === "seat").length,
      busyLab: this.slots.filter((s) => s.job?.priority === "lab").length,
      queuedSeat: this.seatQueue.length,
      queuedLab: this.labQueue.length,
    };
  }

  submit(priority: BotJobPriority, input: BotDecisionInput): BotPoolTask {
    if (this.closed) return rejected(new BotRunnerError("VALIDATION_ERROR", "bot pool is shut down"));
    if (priority !== "seat" && priority !== "lab") {
      return rejected(new BotRunnerError("VALIDATION_ERROR", "priority must be seat or lab"));
    }
    if (priority === "lab" && this.size - this.reservedSeatSlots === 0) {
      return rejected(new BotRunnerError("VALIDATION_ERROR", "this pool reserves every slot for seats"));
    }
    const queue = priority === "seat" ? this.seatQueue : this.labQueue;
    const max = priority === "seat" ? this.seatQueueMax : this.labQueueMax;
    if (queue.length >= max && !this.canStartNow(priority)) {
      return rejected(new BotRunnerError("RUNNER_BUSY", `bot ${priority} queue is full`));
    }
    let job!: Job;
    const promise = new Promise<BotDecisionOutput>((resolve, reject) => {
      job = {
        priority,
        request: { type: "choose", id: this.nextId++, ...input },
        resolve,
        reject,
        settled: false,
      };
    });
    queue.push(job);
    this.pump();
    return { promise, cancel: () => this.cancel(job) };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of [...this.seatQueue.splice(0), ...this.labQueue.splice(0)]) {
      this.settle(job, new BotRunnerError("CANCELLED", "bot pool shut down"));
    }
    for (const slot of this.slots) if (slot.job !== null) this.cancel(slot.job);
    await Promise.all(this.slots.splice(0).map((s) => s.worker.terminate()));
  }

  private canStartNow(priority: BotJobPriority): boolean {
    const free = this.slots.some((s) => s.job === null) || this.slots.length < this.size;
    if (!free) return false;
    if (priority === "seat") return this.seatQueue.length === 0;
    return this.labQueue.length === 0 && this.seatQueue.length === 0 && this.labCapacityLeft();
  }

  private labCapacityLeft(): boolean {
    const busyLab = this.slots.filter((s) => s.job?.priority === "lab").length;
    return busyLab < this.size - this.reservedSeatSlots;
  }

  private cancel(job: Job): void {
    if (job.settled) return;
    for (const queue of [this.seatQueue, this.labQueue]) {
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
    }
    const slot = this.slots.find((s) => s.job === job);
    if (slot !== undefined) Atomics.store(slot.flag, 0, 1); // search stops at its next node
    this.settle(job, new BotRunnerError("CANCELLED", "bot decision cancelled"));
  }

  private settle(job: Job, outcome: BotDecisionOutput | Error): void {
    if (job.settled) return;
    job.settled = true;
    if (outcome instanceof Error) job.reject(outcome);
    else job.resolve(outcome);
  }

  private pump(): void {
    for (;;) {
      const next =
        this.seatQueue.length > 0
          ? this.seatQueue
          : this.labQueue.length > 0 && this.labCapacityLeft()
            ? this.labQueue
            : null;
      if (next === null) return;
      let slot = this.slots.find((s) => s.job === null);
      if (slot === undefined && this.slots.length < this.size) slot = this.spawn();
      if (slot === undefined) return;
      this.run(slot, next.shift() as Job);
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
    let dead = false;
    const onDeath = (error: Error): void => {
      if (dead) return;
      dead = true;
      const job = slot.job;
      slot.job = null;
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots.splice(i, 1);
      if (job !== null) this.settle(job, error);
      if (!this.closed) this.pump();
    };
    worker.on("error", onDeath);
    worker.on("exit", (code) => onDeath(new Error(`bot worker exited with code ${code}`)));
    this.slots.push(slot);
    return slot;
  }

  private run(slot: Slot, job: Job): void {
    slot.job = job;
    Atomics.store(slot.flag, 0, job.settled ? 1 : 0);
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
    if (reply.type === "error") this.settle(job, new Error(reply.message));
    else this.settle(job, { result: reply.result, elapsedMs: reply.elapsedMs });
    this.pump();
  }
}

function rejected(error: Error): BotPoolTask {
  const promise = Promise.reject(error);
  promise.catch(() => undefined);
  return { promise, cancel: () => undefined };
}
