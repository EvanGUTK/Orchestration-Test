import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { BOT_VERSION } from "@2048/contracts";
import type { BotConfig, Decimal, Direction, Exponent, GameState, Ruleset } from "@2048/contracts";
import { describeBot, validateBotConfig } from "./config.ts";
import { CTL_CANCEL, CTL_LENGTH, CTL_PAUSED, CTL_STEP, CTL_WAKE } from "./protocol.ts";
import type { WorkerFinal, WorkerInit, WorkerMessage } from "./protocol.ts";
import { maxExponentOf } from "./run.ts";
import type { BotMoveRecord } from "./run.ts";
import type { BotMetadata } from "./types.ts";

export type BotRunStatus = "running" | "paused" | "finished" | "cancelled" | "error";

export type BotRunOptions = {
  id?: string;
  config: BotConfig;
  rules: Ruleset;
  gameSeed: string;
  maxMoves?: number;
  /** Deterministic runs: ignore wall time, bound only by node budget. */
  ignoreTimeBudget?: boolean;
  startPaused?: boolean;
  onProgress?: (record: BotMoveRecord) => void;
  /** Kill the worker if no progress arrives for this long while running. Default: 5x timeBudgetMs + 2s (none when ignoreTimeBudget). */
  watchdogMs?: number | null;
  /** After cancel(), wait this long for a graceful stop before terminating the thread. */
  cancelGraceMs?: number;
};

export type BotRunResult = {
  id: string;
  status: Exclude<BotRunStatus, "running" | "paused">;
  botVersion: string;
  metadata: BotMetadata;
  config: BotConfig;
  gameSeed: string;
  rulesetVersion: string;
  directions: Direction[];
  movesPlayed: number;
  score: Decimal;
  maxExponent: Exponent;
  nodes: number;
  finalChecksum: string | null;
  state: GameState | null;
  lastExplanation: string | null;
  error?: string;
};

export type BotRunHandle = {
  readonly id: string;
  readonly status: BotRunStatus;
  readonly movesPlayed: number;
  readonly lastRecord: BotMoveRecord | null;
  /** Pause after the move currently being computed. Idempotent. */
  pause(): void;
  resume(): void;
  /** Play exactly one more move, then stay paused. */
  step(): void;
  /** Cooperative stop (observed inside the running search); idempotent. */
  cancel(): void;
  /** Hard stop; resolves `done` as cancelled/error immediately. */
  terminate(): Promise<void>;
  readonly done: Promise<BotRunResult>;
};

function ctlWake(ctl: Int32Array): void {
  Atomics.add(ctl, CTL_WAKE, 1);
  Atomics.notify(ctl, CTL_WAKE);
}

/** Start a bot game in a worker thread. The caller's thread is never blocked by search. */
export function startBotRun(options: BotRunOptions): BotRunHandle {
  const config = validateBotConfig(options.config);
  const id = options.id ?? randomUUID();
  const metadata = describeBot(config);
  const control = new SharedArrayBuffer(CTL_LENGTH * Int32Array.BYTES_PER_ELEMENT);
  const ctl = new Int32Array(control);
  const init: WorkerInit = { runId: id, config, rules: options.rules, gameSeed: options.gameSeed, maxMoves: options.maxMoves, ignoreTimeBudget: options.ignoreTimeBudget, startPaused: options.startPaused, control };
  if (options.startPaused) Atomics.store(ctl, CTL_PAUSED, 1);

  const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: init });
  let status: BotRunStatus = options.startPaused ? "paused" : "running";
  let lastRecord: BotMoveRecord | null = null;
  let settled = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSteps = 0; // step() tokens not yet answered by a progress message
  let resolveDone!: (r: BotRunResult) => void;
  const done = new Promise<BotRunResult>((res) => { resolveDone = res; });
  const watchdogMs = options.watchdogMs !== undefined ? options.watchdogMs : options.ignoreTimeBudget ? null : config.timeBudgetMs * 5 + 2000;

  const base = (): Omit<BotRunResult, "status" | "directions" | "movesPlayed" | "score" | "maxExponent" | "nodes" | "finalChecksum" | "state" | "lastExplanation"> => ({
    id, botVersion: BOT_VERSION, metadata, config, gameSeed: options.gameSeed, rulesetVersion: options.rules.version,
  });
  const settle = (result: BotRunResult): void => {
    if (settled) return;
    settled = true;
    status = result.status;
    if (watchdog) clearTimeout(watchdog);
    if (cancelTimer) clearTimeout(cancelTimer);
    resolveDone(result);
  };
  const partial = (st: "cancelled" | "error", error?: string): BotRunResult => ({
    ...base(), status: st, directions: [], movesPlayed: lastRecord?.sequence ?? 0, score: lastRecord?.score ?? "0", maxExponent: lastRecord?.maxExponent ?? "0",
    nodes: 0, finalChecksum: lastRecord?.checksum ?? null, state: null, lastExplanation: lastRecord?.explanation ?? null, ...(error ? { error } : {}),
  });
  const fromFinal = (st: "finished" | "cancelled", f: WorkerFinal): BotRunResult => ({
    ...base(), status: st, directions: f.moves, movesPlayed: f.moves.length, score: f.state.score, maxExponent: maxExponentOf(f.state), nodes: f.nodes,
    finalChecksum: f.last?.checksum ?? null, state: f.state, lastExplanation: f.last?.explanation ?? null,
  });
  const armWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    if (watchdogMs === null || settled || (status !== "running" && pendingSteps === 0)) return;
    watchdog = setTimeout(() => {
      if (settled) return;
      void worker.terminate();
      settle(partial("error", "bot worker unresponsive (watchdog)"));
    }, watchdogMs);
    watchdog.unref();
  };

  worker.on("message", (m: WorkerMessage) => {
    switch (m.type) {
      case "progress":
        lastRecord = m.record;
        if (pendingSteps > 0) pendingSteps--;
        options.onProgress?.(m.record);
        armWatchdog();
        break;
      case "paused":
        if (watchdog) clearTimeout(watchdog);
        break;
      case "finished":
        settle(fromFinal("finished", m.final));
        void worker.terminate();
        break;
      case "cancelled":
        settle(fromFinal("cancelled", m.final));
        void worker.terminate();
        break;
      case "error":
        settle(partial("error", m.message));
        void worker.terminate();
        break;
      case "started":
        armWatchdog();
        break;
    }
  });
  worker.on("error", (e) => settle(partial("error", e instanceof Error ? e.message : String(e))));
  worker.on("exit", (code) => {
    if (!settled) settle(partial(code === 0 ? "cancelled" : "error", code === 0 ? undefined : `bot worker exited with code ${code}`));
  });

  const requireActive = (): boolean => !settled;
  return {
    id,
    get status() { return status; },
    get movesPlayed() { return lastRecord?.sequence ?? 0; },
    get lastRecord() { return lastRecord; },
    pause() {
      if (!requireActive() || status === "paused") return;
      status = "paused";
      Atomics.store(ctl, CTL_PAUSED, 1);
      ctlWake(ctl);
    },
    resume() {
      if (!requireActive() || status !== "paused") return;
      status = "running";
      pendingSteps = 0;
      Atomics.store(ctl, CTL_STEP, 0);
      Atomics.store(ctl, CTL_PAUSED, 0);
      ctlWake(ctl);
      armWatchdog();
    },
    step() {
      if (!requireActive()) return;
      if (status !== "paused") {
        status = "paused";
        Atomics.store(ctl, CTL_PAUSED, 1);
      }
      Atomics.add(ctl, CTL_STEP, 1);
      pendingSteps++;
      ctlWake(ctl);
      armWatchdog();
    },
    cancel() {
      if (!requireActive()) return;
      Atomics.store(ctl, CTL_CANCEL, 1);
      ctlWake(ctl);
      if (!cancelTimer) {
        cancelTimer = setTimeout(() => {
          if (settled) return;
          void worker.terminate();
          settle(partial("cancelled"));
        }, options.cancelGraceMs ?? 2000);
        cancelTimer.unref();
      }
    },
    async terminate() {
      if (!settled) settle(partial("cancelled"));
      await worker.terminate();
    },
    done,
  };
}

