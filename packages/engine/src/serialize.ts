import {
  CANONICAL_BOARD_KEYS,
  CANONICAL_RNG_KEYS,
  CANONICAL_STATE_KEYS,
  RNG_ALGORITHM,
} from "@g2048/contracts";
import type { GameState } from "@g2048/contracts";
import { invalid } from "./errors.js";
import { sha256Hex } from "./sha256.js";
import { validateGameState } from "./state.js";

/** Largest serialized state accepted by deserialize (a maximal legal state is well under 400 KB). */
export const MAX_STATE_JSON_LENGTH = 1_000_000;

/**
 * Canonical JSON (CONTRACT-001 decision 8): CANONICAL_STATE_KEYS order (board: size, cells; rng:
 * algorithm, words), no whitespace, decimal strings as strings, uint32 words as numbers, null for
 * empty cells. Validates the state first (VALIDATION_ERROR / REPLAY_VERSION_UNSUPPORTED).
 */
export function canonicalJson(state: GameState): string {
  validateGameState(state);
  // Exponents and score are validated canonical digit strings, so they need no escaping.
  let cells = "";
  for (const cell of state.board.cells) {
    if (cells.length > 0) cells += ",";
    cells += cell === null ? "null" : `"${cell}"`;
  }
  const [w0, w1, w2, w3] = state.rng.words;
  return (
    `{"schemaVersion":${state.schemaVersion}` +
    `,"engineVersion":${JSON.stringify(state.engineVersion)}` +
    `,"rulesetVersion":${JSON.stringify(state.rulesetVersion)}` +
    `,"board":{"size":${state.board.size},"cells":[${cells}]}` +
    `,"score":"${state.score}"` +
    `,"acceptedMoves":${state.acceptedMoves}` +
    `,"revision":${state.revision}` +
    `,"rng":{"algorithm":"${RNG_ALGORITHM}","words":[${w0},${w1},${w2},${w3}]}` +
    `,"status":"${state.status}"` +
    `,"celebrated2048":${state.celebrated2048 ? "true" : "false"}}`
  );
}

/** Lowercase hex SHA-256 of the UTF-8 canonical JSON. */
export function checksum(state: GameState): string {
  return sha256Hex(canonicalJson(state));
}

/** Serialized form of a state; identical to canonicalJson. */
export function serialize(state: GameState): string {
  return canonicalJson(state);
}

function requireExactKeys(value: object, keys: readonly string[], what: string): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw invalid(`${what} must have exactly the keys ${keys.join(", ")}`);
  }
}

/**
 * Parses and strictly validates a serialized GameState. Throws EngineError: REPLAY_VERSION_UNSUPPORTED
 * for an unsupported schemaVersion, engineVersion or rng algorithm; VALIDATION_ERROR for malformed
 * JSON, unknown or missing keys, out-of-range words, an all-zero rng state, board size outside 3..8,
 * wrong cells length, non-canonical exponents or score, or exponents above LIMITS.maxExponent.
 * Values are preserved exactly (strings stay strings).
 */
export function deserialize(json: string): GameState {
  if (typeof json !== "string") throw invalid("serialized state must be a string");
  if (json.length > MAX_STATE_JSON_LENGTH) throw invalid("serialized state is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalid("serialized state is not valid JSON");
  }
  validateGameState(parsed);
  requireExactKeys(parsed, CANONICAL_STATE_KEYS, "state");
  requireExactKeys(parsed.board, CANONICAL_BOARD_KEYS, "state.board");
  requireExactKeys(parsed.rng, CANONICAL_RNG_KEYS, "state.rng");
  const [w0, w1, w2, w3] = parsed.rng.words;
  return {
    schemaVersion: parsed.schemaVersion,
    engineVersion: parsed.engineVersion,
    rulesetVersion: parsed.rulesetVersion,
    board: { size: parsed.board.size, cells: parsed.board.cells.slice() },
    score: parsed.score,
    acceptedMoves: parsed.acceptedMoves,
    revision: parsed.revision,
    rng: { algorithm: RNG_ALGORITHM, words: [w0, w1, w2, w3] },
    status: parsed.status,
    celebrated2048: parsed.celebrated2048,
  };
}
