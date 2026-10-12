// @g2048/bots: deterministic game bots (COMP-002/003). Pure; no I/O, network, or LLM calls.
// The worker_threads runner lives in the Node-only subpath export "@g2048/bots/runner".
import { createChooseMove } from "./choose-move.js";
import { engineAdapter } from "./engine-adapter.js";

export const PACKAGE_NAME = "@g2048/bots";

/** CONTRACT-001 chooseMove bound to @g2048/engine. */
export const chooseMove = createChooseMove(engineAdapter);

export {
  BOT_VERSION,
  BotError,
  createChooseMove,
  deriveBotRng,
  difficultyOf,
  validateBotConfig,
} from "./choose-move.js";
export type { BotErrorCode, ChooseMove, ChooseMoveOptions, ChooseMoveResult } from "./choose-move.js";
export { CLOCK_CHECK_INTERVAL } from "./budget.js";
export type { AbortReason, CancelSignal } from "./budget.js";
export type { EnginePort } from "./engine-port.js";
export { engineAdapter } from "./engine-adapter.js";
export {
  DEAD_BOARD_VALUE,
  EVAL_VERSION,
  EVAL_WEIGHTS,
  evaluateBoard,
  evaluateExponents,
} from "./evaluate.js";
export { EXPECTIMAX_MAX_DEPTH, HEURISTIC_MAX_DEPTH, STRATEGIES } from "./strategies.js";
export { playBotGame, runTournament } from "./play.js";
export type {
  BotGameEnd,
  BotGameInput,
  BotGameResult,
  TournamentEntry,
  TournamentGame,
  TournamentPairing,
  TournamentResult,
  TournamentRow,
  TournamentSeat,
} from "./play.js";
export { nextBotSeatAction, planBotSeat } from "./seat-driver.js";
export type { BotSeatAction, BotSeatPlan } from "./seat-driver.js";
export { leagueGamesFromTournament } from "./league.js";
