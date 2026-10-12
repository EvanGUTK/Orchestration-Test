// worker_threads entry: runs bot searches off the caller's event loop.
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { createChooseMove } from "../choose-move.js";
import { engineAdapter } from "../engine-adapter.js";
import type { BotWorkerData, ChooseRequest, WorkerReply } from "./protocol.js";

const port = parentPort;
if (port === null) throw new Error("bot-worker must run inside worker_threads");

const flag = new Int32Array((workerData as BotWorkerData).cancelBuffer);
const signal = {
  get cancelled(): boolean {
    return Atomics.load(flag, 0) === 1;
  },
};
const chooseMove = createChooseMove(engineAdapter);
const now = (): number => performance.now();

port.on("message", (request: ChooseRequest) => {
  const started = now();
  let reply: WorkerReply;
  try {
    const result = chooseMove(request.state, request.rules, request.config, request.botRng, signal, { now });
    reply = { type: "result", id: request.id, result, elapsedMs: now() - started };
  } catch (error) {
    reply = {
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(reply);
});
port.postMessage({ type: "ready" } satisfies WorkerReply);
