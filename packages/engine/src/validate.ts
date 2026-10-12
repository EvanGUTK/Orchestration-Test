import {
  DomainError, ENGINE_VERSION, MAX_BOARD_SIZE, MAX_DECIMAL_DIGITS, MIN_BOARD_SIZE, PRNG_ALGORITHM,
  STATE_SCHEMA_VERSION, canonicalStateJson,
} from "@2048/contracts";
import type { GameState, Ruleset } from "@2048/contracts";
import { sha256Hex } from "./sha256.ts";
import { assertWords } from "./prng.ts";
import { assertCell } from "./slide.ts";

/** Upper bound for accepted serialized state text (bytes of UTF-16 code units); larger is RESOURCE_LIMIT. */
export const MAX_SERIALIZED_LENGTH = 16_000_000;

const DEC_RE = /^(0|[1-9][0-9]*)$/;
const STATE_KEYS = [
  "schemaVersion", "engineVersion", "rulesetVersion", "board", "score", "acceptedMoves", "revision",
  "rng", "status", "celebrated2048",
];

function bad(message: string, details?: unknown): never {
  throw new DomainError("VALIDATION_ERROR", message, details);
}

function isSafeCounter(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

/** Structural validation without copying. Throws VALIDATION_ERROR or RESOURCE_LIMIT. */
export function assertGameState(value: unknown): asserts value is GameState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("state must be an object");
  const s = value as Record<string, unknown>;
  if (!hasExactKeys(s, STATE_KEYS)) bad("state has missing or unknown fields");
  if (s.schemaVersion !== STATE_SCHEMA_VERSION) bad("unsupported schemaVersion");
  if (s.engineVersion !== ENGINE_VERSION) bad("unsupported engineVersion");
  if (typeof s.rulesetVersion !== "string" || s.rulesetVersion.length === 0 || s.rulesetVersion.length > 200) {
    bad("invalid rulesetVersion");
  }
  const board = s.board as { size?: unknown; cells?: unknown } | null;
  if (typeof board !== "object" || board === null || !hasExactKeys(board, ["size", "cells"])) bad("invalid board");
  const size = board.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < MIN_BOARD_SIZE || size > MAX_BOARD_SIZE) {
    bad("board size must be an integer from 3 to 8");
  }
  const cells = board.cells;
  if (!Array.isArray(cells) || cells.length !== size * size) bad("board must have size*size cells");
  for (let i = 0; i < cells.length; i++) assertCell(cells[i], i);
  if (typeof s.score !== "string") bad("score must be a decimal string");
  if (s.score.length > MAX_DECIMAL_DIGITS) {
    throw new DomainError("RESOURCE_LIMIT", "score exceeds the maximum supported size");
  }
  if (!DEC_RE.test(s.score)) bad("score must be a canonical decimal string");
  if (!isSafeCounter(s.acceptedMoves)) bad("acceptedMoves must be a nonnegative safe integer");
  if (!isSafeCounter(s.revision)) bad("revision must be a nonnegative safe integer");
  const rng = s.rng as { algorithm?: unknown; words?: unknown } | null;
  if (typeof rng !== "object" || rng === null || !hasExactKeys(rng, ["algorithm", "words"])) bad("invalid rng");
  if (rng.algorithm !== PRNG_ALGORITHM) bad("unsupported rng algorithm");
  assertWords(rng.words);
  if (s.status !== "active" && s.status !== "completed" && s.status !== "forfeited") bad("invalid status");
  if (typeof s.celebrated2048 !== "boolean") bad("celebrated2048 must be a boolean");
}

/** Validates an untrusted value and returns a fresh, deep-copied GameState. */
export function validateState(state: unknown): GameState {
  assertGameState(state);
  const s = state;
  return {
    schemaVersion: s.schemaVersion,
    engineVersion: s.engineVersion,
    rulesetVersion: s.rulesetVersion,
    board: { size: s.board.size, cells: s.board.cells.slice() },
    score: s.score,
    acceptedMoves: s.acceptedMoves,
    revision: s.revision,
    rng: { algorithm: s.rng.algorithm, words: [...s.rng.words] },
    status: s.status,
    celebrated2048: s.celebrated2048,
  };
}

export function assertRules(rules: unknown): asserts rules is Ruleset {
  const r = rules as Ruleset | null;
  if (typeof r !== "object" || r === null) bad("rules must be an object");
  if (typeof r.version !== "string" || r.version.length === 0) bad("rules.version must be a non-empty string");
  if (!Number.isInteger(r.boardSize) || r.boardSize < MIN_BOARD_SIZE || r.boardSize > MAX_BOARD_SIZE) {
    bad("rules.boardSize must be an integer from 3 to 8");
  }
  if (!Number.isInteger(r.startTiles) || r.startTiles < 1 || r.startTiles > r.boardSize * r.boardSize - 1) {
    bad("rules.startTiles out of range");
  }
  if (!Number.isInteger(r.spawnFourTenths) || r.spawnFourTenths < 0 || r.spawnFourTenths > 10) {
    bad("rules.spawnFourTenths must be an integer from 0 to 10");
  }
  if (r.moveCap !== null && !isSafeCounter(r.moveCap)) bad("rules.moveCap must be null or a safe integer");
  if (r.moveCap === 0) bad("rules.moveCap must be positive");
}

export function serialize(state: GameState): string {
  assertGameState(state);
  return canonicalStateJson(state);
}

export function deserialize(json: string): GameState {
  if (typeof json !== "string") bad("serialized state must be a string");
  if (json.length > MAX_SERIALIZED_LENGTH) {
    throw new DomainError("RESOURCE_LIMIT", "serialized state exceeds the maximum supported size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    bad("serialized state is not valid JSON");
  }
  return validateState(parsed);
}

/** Checksum of an engine-produced (already trusted) state. */
export function checksumTrusted(state: GameState): string {
  return sha256Hex(canonicalStateJson(state));
}

export function stateChecksum(state: GameState): string {
  assertGameState(state);
  return checksumTrusted(state);
}
