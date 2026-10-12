import { parentPort, workerData } from "node:worker_threads";
import { BotGame } from "./run.ts";
import { describeBot } from "./config.ts";
import { CTL_CANCEL, CTL_PAUSED, CTL_STEP, CTL_WAKE } from "./protocol.ts";
import type { WorkerFinal, WorkerInit, WorkerMessage } from "./protocol.ts";

/**
 * Bot run worker (Node worker_threads). Pause/step/cancel are SharedArrayBuffer flags so cancellation is
 * observed from INSIDE a running search (the Budget polls the signal) and pause/step never depend on
 * message-loop turns. Pause takes effect between moves. No network, no clock-dependent decisions
 * unless the host left the time budget enabled.
 */
const port = parentPort;
if (!port) throw new Error("worker.ts must run inside a worker thread");
const init = workerData as WorkerInit;
const ctl = new Int32Array(init.control);
const post = (m: WorkerMessage): void => port.postMessage(m);
const cancelled = (): boolean => Atomics.load(ctl, CTL_CANCEL) === 1;
const signal = {
  get aborted(): boolean {
    return cancelled();
  },
};

function finalOf(game: BotGame): WorkerFinal {
  return { state: game.state, moves: [...game.moves], nodes: game.totalNodes, last: game.last };
}

try {
  const game = new BotGame({ rules: init.rules, gameSeed: init.gameSeed, config: init.config, maxMoves: init.maxMoves, ignoreTimeBudget: init.ignoreTimeBudget, signal });
  post({ type: "started", metadata: describeBot(init.config) });
  if (init.startPaused) Atomics.store(ctl, CTL_PAUSED, 1);
  let announcedPause = false;
  let stopped = false;
  while (!game.finished) {
    const wake = Atomics.load(ctl, CTL_WAKE);
    if (cancelled()) {
      stopped = true;
      break;
    }
    if (Atomics.load(ctl, CTL_PAUSED) === 1) {
      const tokens = Atomics.load(ctl, CTL_STEP);
      if (tokens <= 0) {
        if (!announcedPause) {
          post({ type: "paused" });
          announcedPause = true;
        }
        Atomics.wait(ctl, CTL_WAKE, wake); // sleeps until the host changes any flag and notifies
        continue;
      }
      Atomics.sub(ctl, CTL_STEP, 1);
    }
    announcedPause = false;
    const record = game.step();
    if (record === null) {
      stopped = cancelled();
      break;
    }
    post({ type: "progress", record });
  }
  post({ type: stopped || (cancelled() && !game.finished) ? "cancelled" : "finished", final: finalOf(game) });
} catch (e) {
  post({ type: "error", message: e instanceof Error ? e.message : String(e) });
}
