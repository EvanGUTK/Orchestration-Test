// @g2048/bots/runner: Node-only worker_threads execution (kept out of the browser-safe root export).
export { createBotServices } from "./services.js";
export type { BotServices } from "./services.js";
export { BotRunnerError, BotWorkerPool } from "./pool.js";
export type {
  BotDecisionInput,
  BotDecisionOutput,
  BotJobPriority,
  BotPoolErrorCode,
  BotPoolStats,
  BotPoolTask,
  BotWorkerPoolOptions,
} from "./pool.js";
export { BotRunner } from "./runner.js";
export type {
  BotRunHandle,
  BotRunnerErrorCode,
  BotRunnerOptions,
  BotRunParams,
  BotRunProgress,
  BotRunResult,
  BotRunStatus,
} from "./runner.js";
export { BotSeatDriver } from "./seat-driver.js";
export type { BotSeatDriverOptions, BotSeatRequest } from "./seat-driver.js";
export { stressBots } from "./stress.js";
export type { StressBotsOptions, StressBotsResult } from "./stress.js";
