import { parentPort, workerData } from "node:worker_threads";
import { runTournament } from "./tournament.ts";
import { CTL_CANCEL } from "./protocol.ts";
import type { TournamentWorkerInit, TournamentWorkerMessage } from "./protocol.ts";

/**
 * Runs a whole league in a worker thread. Progress is one message per finished game; cancellation is a
 * SharedArrayBuffer flag polled inside every search (so it stops mid-game, not only between games).
 */
const port = parentPort;
if (!port) throw new Error("tournament-worker.ts must run inside a worker thread");
const init = workerData as TournamentWorkerInit;
const ctl = new Int32Array(init.control);
const post = (m: TournamentWorkerMessage): void => port.postMessage(m);
const signal = {
  get aborted(): boolean {
    return Atomics.load(ctl, CTL_CANCEL) === 1;
  },
};

try {
  const totalGames = init.options.entries.length * init.options.gameSeeds.length;
  post({ type: "started", totalGames });
  let completed = 0;
  const result = runTournament({
    ...init.options,
    signal,
    onGame: (game) => post({ type: "game", game, completed: ++completed, totalGames }),
  });
  post({ type: result.cancelled ? "cancelled" : "finished", result });
} catch (e) {
  post({ type: "error", message: e instanceof Error ? e.message : String(e) });
}
