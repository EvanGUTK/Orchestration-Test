// @g2048/competition: pure competition rules (COMP-001). No I/O, clocks, randomness, or engine import.
export const PACKAGE_NAME = "@g2048/competition";

export { CompetitionError } from "./errors.js";
export type { CompetitionErrorCode } from "./errors.js";
export * from "./decimal.js";
export * from "./elo.js";
export * from "./standings.js";
export * from "./duel.js";
export * from "./match.js";
export * from "./challenge.js";
export * from "./season.js";
export * from "./bot-league.js";
export * from "./profile-stats.js";
export * from "./challenge-catalog.js";
export * from "./human-vs-bot.js";
