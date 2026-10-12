import { Worker } from "node:worker_threads";
import { CTL_CANCEL, CTL_LENGTH, CTL_WAKE } from "./protocol.ts";
import type { TournamentWorkerInit, TournamentWorkerMessage } from "./protocol.ts";
import { validateBotConfig } from "./config.ts";
import type { SerializableTournamentOptions, TournamentGame, TournamentResult } from "./tournament.ts";

export type TournamentRunStatus = "running" | "finished" | "cancelled" | "error";

export type TournamentProgress = { game: TournamentGame; completed: number; totalGames: number };

export type TournamentRunOptions = SerializableTournamentOptions & {
  onProgress?: (p: TournamentProgress) => void;
  /** After cancel(), terminate the thread if it has not stopped within this time. */
  cancelGraceMs?: number;
};

export type TournamentRunOutcome =
  | { status: "finished" | "cancelled"; result: TournamentResult; error?: undefined }
  | { status: "error"; result: null; error: string };

export type TournamentRunHandle = {
  readonly status: TournamentRunStatus;
  readonly completed: number;
  readonly totalGames: number;
  /** Cooperative cancel, observed inside the running search. Idempotent. */
  cancel(): void;
  terminate(): Promise<void>;
  readonly done: Promise<TournamentRunOutcome>;
};

/** Run `runTournament` in a worker thread with per-game progress and cancellation. Never blocks the caller's loop. */
export function startTournament(options: TournamentRunOptions): TournamentRunHandle {
  const { onProgress, cancelGraceMs, ...serializable } = options;
  // Validate on the caller's side so bad input throws synchronously instead of surfacing as a worker error.
  for (const e of serializable.entries) validateBotConfig(e.config);
  const control = new SharedArrayBuffer(CTL_LENGTH * Int32Array.BYTES_PER_ELEMENT);
  const ctl = new Int32Array(control);
  const init: TournamentWorkerInit = { runId: "tournament", options: serializable, control };
  const worker = new Worker(new URL("./tournament-worker.ts", import.meta.url), { workerData: init });

  let status: TournamentRunStatus = "running";
  let completed = 0;
  let totalGames = serializable.entries.length * serializable.gameSeeds.length;
  let settled = false;
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone!: (o: TournamentRunOutcome) => void;
  const done = new Promise<TournamentRunOutcome>((res) => { resolveDone = res; });
  const settle = (o: TournamentRunOutcome): void => {
    if (settled) return;
    settled = true;
    status = o.status;
    if (cancelTimer) clearTimeout(cancelTimer);
    resolveDone(o);
  };

  worker.on("message", (m: TournamentWorkerMessage) => {
    switch (m.type) {
      case "started": totalGames = m.totalGames; break;
      case "game":
        completed = m.completed;
        onProgress?.({ game: m.game, completed: m.completed, totalGames: m.totalGames });
        break;
      case "finished": settle({ status: "finished", result: m.result }); void worker.terminate(); break;
      case "cancelled": settle({ status: "cancelled", result: m.result }); void worker.terminate(); break;
      case "error": settle({ status: "error", result: null, error: m.message }); void worker.terminate(); break;
    }
  });
  worker.on("error", (e) => settle({ status: "error", result: null, error: e instanceof Error ? e.message : String(e) }));
  worker.on("exit", (code) => settle({ status: "error", result: null, error: `tournament worker exited (code ${code}) before reporting` }));

  return {
    get status() { return status; },
    get completed() { return completed; },
    get totalGames() { return totalGames; },
    cancel() {
      if (settled) return;
      Atomics.store(ctl, CTL_CANCEL, 1);
      Atomics.add(ctl, CTL_WAKE, 1);
      if (!cancelTimer) {
        cancelTimer = setTimeout(() => {
          if (settled) return;
          void worker.terminate();
          settle({ status: "error", result: null, error: "tournament worker did not stop within the cancel grace period" });
        }, cancelGraceMs ?? 3000);
        cancelTimer.unref();
      }
    },
    async terminate() {
      if (!settled) settle({ status: "error", result: null, error: "terminated" });
      await worker.terminate();
    },
    done,
  };
}
