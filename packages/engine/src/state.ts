import { ENGINE_VERSION, MAX_BOARD_SIZE, MIN_BOARD_SIZE, SCHEMA_VERSION } from "@g2048/contracts";
import type { GameState, Ruleset } from "@g2048/contracts";
import { compareCanonical, isDecimal, MAX_EXPONENT } from "./decimal.js";
import { EngineError, invalid } from "./errors.js";
import { validateRandomState } from "./rng.js";
import { validateBoard } from "./slide.js";

/** Ruleset/version identifiers: lowercase ASCII, digits, '.', '_' or '-', 1..64 chars. */
export const VERSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Upper bound on score digits. 2^LIMITS.maxExponent has 301,030 digits; no reachable score exceeds
 * this bound, so longer strings are malformed and are rejected before any BigInt parse.
 */
export const MAX_SCORE_DIGITS = 301_100;

const STATUSES = new Set(["active", "completed", "forfeited"]);

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Full structural validation of a GameState (CONTRACT-001). Throws EngineError:
 * REPLAY_VERSION_UNSUPPORTED for an unsupported schemaVersion, engineVersion, or rng algorithm;
 * VALIDATION_ERROR for anything else malformed (board size 3..8, cells length, canonical exponent
 * strings no larger than LIMITS.maxExponent, canonical decimal score, counters, uint32 non-zero words,
 * status, celebrated2048).
 */
export function validateGameState(state: unknown): asserts state is GameState {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw invalid("state must be an object");
  }
  const s = state as Record<string, unknown>;
  if (typeof s.schemaVersion !== "number") throw invalid("schemaVersion must be a number");
  if (s.schemaVersion !== SCHEMA_VERSION) {
    throw new EngineError(
      "REPLAY_VERSION_UNSUPPORTED",
      `unsupported schemaVersion ${String(s.schemaVersion)}`,
    );
  }
  if (typeof s.engineVersion !== "string") throw invalid("engineVersion must be a string");
  if (s.engineVersion !== ENGINE_VERSION) {
    throw new EngineError(
      "REPLAY_VERSION_UNSUPPORTED",
      `unsupported engineVersion ${JSON.stringify(s.engineVersion.slice(0, 32))}`,
    );
  }
  if (typeof s.rulesetVersion !== "string" || !VERSION_ID_PATTERN.test(s.rulesetVersion)) {
    throw invalid("rulesetVersion must match /^[a-z0-9][a-z0-9._-]{0,63}$/");
  }
  validateBoard(s.board);
  for (const cell of s.board.cells) {
    if (cell !== null && compareCanonical(cell, MAX_EXPONENT) > 0) {
      throw invalid(`board exponent exceeds LIMITS.maxExponent ${MAX_EXPONENT}`);
    }
  }
  if (typeof s.score !== "string" || s.score.length > MAX_SCORE_DIGITS || !isDecimal(s.score)) {
    throw invalid("score must be a canonical decimal string");
  }
  if (!isCounter(s.acceptedMoves)) throw invalid("acceptedMoves must be a nonnegative safe integer");
  if (!isCounter(s.revision)) throw invalid("revision must be a nonnegative safe integer");
  validateRandomState(s.rng, true);
  if (typeof s.status !== "string" || !STATUSES.has(s.status)) {
    throw invalid("status must be active, completed, or forfeited");
  }
  if (typeof s.celebrated2048 !== "boolean") throw invalid("celebrated2048 must be a boolean");
}

/** Validates the engine-relevant fields of a Ruleset. Throws VALIDATION_ERROR. */
export function validateRuleset(rules: unknown): asserts rules is Ruleset {
  if (typeof rules !== "object" || rules === null) throw invalid("rules must be an object");
  const r = rules as Record<string, unknown>;
  if (typeof r.version !== "string" || !VERSION_ID_PATTERN.test(r.version)) {
    throw invalid("rules.version must match /^[a-z0-9][a-z0-9._-]{0,63}$/");
  }
  if (
    typeof r.size !== "number" ||
    !Number.isInteger(r.size) ||
    r.size < MIN_BOARD_SIZE ||
    r.size > MAX_BOARD_SIZE
  ) {
    throw invalid(`rules.size must be an integer in ${MIN_BOARD_SIZE}..${MAX_BOARD_SIZE}`);
  }
  if (
    typeof r.fourWeight !== "number" ||
    !Number.isInteger(r.fourWeight) ||
    r.fourWeight < 0 ||
    r.fourWeight > 10
  ) {
    throw invalid("rules.fourWeight must be an integer in 0..10");
  }
  if (r.moveCap !== null && !(isCounter(r.moveCap) && r.moveCap >= 1)) {
    throw invalid("rules.moveCap must be null or a positive safe integer");
  }
}

/** Ensures the ruleset matches the state's board size and rulesetVersion. */
export function requireMatchingRuleset(state: GameState, rules: Ruleset): void {
  if (rules.size !== state.board.size) throw invalid("rules.size does not match the board size");
  if (rules.version !== state.rulesetVersion)
    throw invalid("rules.version does not match state.rulesetVersion");
}
