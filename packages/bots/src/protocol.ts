import type { BotConfig, Direction, GameState, Ruleset } from "@2048/contracts";
import type { BotMetadata } from "./types.ts";
import type { BotMoveRecord } from "./run.ts";

/** Shared-memory control block: the host writes, the worker reads (also from inside a running search). */
export const CTL_CANCEL = 0;
export const CTL_PAUSED = 1;
export const CTL_STEP = 2;
export const CTL_WAKE = 3;
export const CTL_LENGTH = 4;

export type WorkerInit = {
  runId: string;
  config: BotConfig;
  rules: Ruleset;
  gameSeed: string;
  maxMoves?: number;
  ignoreTimeBudget?: boolean;
  startPaused?: boolean;
  control: SharedArrayBuffer;
};

export type WorkerFinal = {
  state: GameState;
  moves: Direction[];
  nodes: number;
  last: BotMoveRecord | null;
};

export type WorkerMessage =
  | { type: "started"; metadata: BotMetadata }
  | { type: "progress"; record: BotMoveRecord }
  | { type: "paused" }
  | { type: "finished"; final: WorkerFinal }
  | { type: "cancelled"; final: WorkerFinal }
  | { type: "error"; message: string };

/** Tournament-in-a-worker protocol. Control block reuses CTL_CANCEL only. */
export type TournamentWorkerInit = {
  runId: string;
  options: import("./tournament.ts").SerializableTournamentOptions;
  control: SharedArrayBuffer;
};

export type TournamentWorkerMessage =
  | { type: "started"; totalGames: number }
  | { type: "game"; game: import("./tournament.ts").TournamentGame; completed: number; totalGames: number }
  | { type: "finished"; result: import("./tournament.ts").TournamentResult }
  | { type: "cancelled"; result: import("./tournament.ts").TournamentResult }
  | { type: "error"; message: string };
