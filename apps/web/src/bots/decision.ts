import type { BotConfig, GameState, RandomState, Ruleset } from "@g2048/contracts";
import type { ChooseMoveResult } from "@g2048/bots";

export type DecisionRequest = {
  readonly state: GameState;
  readonly rules: Ruleset;
  readonly config: BotConfig;
  /** Bot RNG from the previous decision; null on the first move (derived from `seed` in the bot namespace). */
  readonly rng: RandomState | null;
  readonly seed: string;
};

export class DecisionCancelled extends Error {
  constructor() {
    super("bot decision cancelled");
    this.name = "DecisionCancelled";
  }
}

/**
 * Where bot search runs. The browser implementation is a Web Worker so search never blocks the UI
 * thread; `cancel()` terminates the worker, which interrupts even a search in the middle of its budget.
 */
export interface DecisionService {
  decide(request: DecisionRequest): Promise<ChooseMoveResult>;
  cancel(): void;
}

type WorkerReply =
  { id: number; ok: true; result: ChooseMoveResult } | { id: number; ok: false; message: string };

export function workerDecisionService(createWorker?: () => Worker): DecisionService | null {
  if (typeof Worker === "undefined" && !createWorker) return null;
  const make =
    createWorker ?? (() => new Worker(new URL("./bot.worker.ts", import.meta.url), { type: "module" }));
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: ChooseMoveResult) => void; reject: (e: Error) => void }>();

  const rejectAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const ensure = () => {
    if (worker) return worker;
    const w = make();
    w.onmessage = (event: MessageEvent<WorkerReply>) => {
      const p = pending.get(event.data.id);
      if (!p) return;
      pending.delete(event.data.id);
      if (event.data.ok) p.resolve(event.data.result);
      else p.reject(new Error(event.data.message));
    };
    w.onerror = () => {
      rejectAll(new Error("The bot worker stopped unexpectedly."));
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  };

  return {
    decide(request) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ensure().postMessage({ id, request });
      });
    },
    cancel() {
      worker?.terminate();
      worker = null;
      rejectAll(new DecisionCancelled());
    },
  };
}
