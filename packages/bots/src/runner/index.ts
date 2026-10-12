// @g2048/bots/runner: Node-only worker_threads runner (kept out of the browser-safe root export).
export { BotRunner, BotRunnerError } from "./runner.js";
export type {
  BotRunHandle,
  BotRunnerErrorCode,
  BotRunnerOptions,
  BotRunParams,
  BotRunProgress,
  BotRunResult,
  BotRunStatus,
} from "./runner.js";
