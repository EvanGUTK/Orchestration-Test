import type { BotConfig, GameState, RandomState, Ruleset } from "@g2048/contracts";
import type { ChooseMoveResult } from "../choose-move.js";

/** workerData for bot-worker: a 1-element Int32Array view over this buffer is the cancel flag. */
export type BotWorkerData = { readonly cancelBuffer: SharedArrayBuffer };

export type ChooseRequest = {
  readonly type: "choose";
  readonly id: number;
  readonly state: GameState;
  readonly rules: Ruleset;
  readonly config: BotConfig;
  readonly botRng: RandomState;
};

export type WorkerReply =
  | { readonly type: "ready" }
  | {
      readonly type: "result";
      readonly id: number;
      readonly result: ChooseMoveResult;
      readonly elapsedMs: number;
    }
  | { readonly type: "error"; readonly id: number; readonly message: string };
