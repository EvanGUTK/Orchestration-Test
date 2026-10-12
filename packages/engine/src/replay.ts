import { ENGINE_VERSION, LIMITS, REPLAY_SCHEMA_VERSION } from "@g2048/contracts";
import type { Direction, EngineErrorCode, GameState, ReplayFile, Ruleset } from "@g2048/contracts";
import { EngineError, invalid } from "./errors.js";
import { applyMove, newGame } from "./game.js";
import { checksum } from "./serialize.js";
import { requireDirection } from "./slide.js";
import { validateGameState, validateRuleset, VERSION_ID_PATTERN } from "./state.js";

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

function requireMoveCount(length: number): void {
  if (length > LIMITS.replayMaxMoves) {
    throw new EngineError("RESOURCE_LIMIT", `replay exceeds ${LIMITS.replayMaxMoves} moves`);
  }
}

/**
 * Re-applies `moves` from `initial` with applyMove and returns the final state plus the checksum of
 * the state after each input move (a no-op move repeats the previous checksum). Throws the first
 * EngineError raised (e.g. GAME_NOT_ACTIVE for a move after completion, RESOURCE_LIMIT for more than
 * LIMITS.replayMaxMoves moves). Inputs are not mutated.
 */
export function replay(
  initial: GameState,
  moves: readonly Direction[],
  rules: Ruleset,
): { final: GameState; checksums: string[] } {
  validateGameState(initial);
  if (!Array.isArray(moves)) throw invalid("moves must be an array");
  requireMoveCount(moves.length);
  let state = initial;
  const checksums: string[] = [];
  for (const direction of moves) {
    state = applyMove(state, direction, rules).state;
    checksums.push(checksum(state));
  }
  return { final: state, checksums };
}

export type VerifyReplayResult =
  | { ok: true; final: GameState }
  | { ok: false; code: EngineErrorCode; atMove: number | null; message: string };

function fail(code: EngineErrorCode, atMove: number | null, message: string): VerifyReplayResult {
  return { ok: false, code, atMove, message };
}

function requireChecksum(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !CHECKSUM_PATTERN.test(value)) {
    throw invalid(`${what} must be a lowercase hex SHA-256`);
  }
}

/** File-level checks; returns the validated initial state. Throws EngineError. */
function verifyHeader(file: unknown, rules: Ruleset): { initial: GameState; moves: unknown[] } {
  if (typeof file !== "object" || file === null || Array.isArray(file))
    throw invalid("replay must be an object");
  const f = file as Record<string, unknown>;
  if (typeof f.replaySchemaVersion !== "number") throw invalid("replaySchemaVersion must be a number");
  if (f.replaySchemaVersion !== REPLAY_SCHEMA_VERSION) {
    throw new EngineError(
      "REPLAY_VERSION_UNSUPPORTED",
      `unsupported replaySchemaVersion ${f.replaySchemaVersion}`,
    );
  }
  if (typeof f.engineVersion !== "string") throw invalid("engineVersion must be a string");
  if (f.engineVersion !== ENGINE_VERSION) {
    throw new EngineError("REPLAY_VERSION_UNSUPPORTED", "unsupported replay engineVersion");
  }
  if (typeof f.rulesetVersion !== "string" || !VERSION_ID_PATTERN.test(f.rulesetVersion)) {
    throw invalid("rulesetVersion is malformed");
  }
  validateRuleset(rules);
  if (f.rulesetVersion !== rules.version) throw invalid("replay rulesetVersion does not match the ruleset");
  if (typeof f.seed !== "string") throw invalid("seed must be a string");
  if (typeof f.meta !== "object" || f.meta === null || Array.isArray(f.meta))
    throw invalid("meta must be an object");

  validateGameState(f.initialState);
  const initial = f.initialState;
  if (initial.rulesetVersion !== f.rulesetVersion)
    throw invalid("initialState.rulesetVersion does not match");
  requireChecksum(f.initialChecksum, "initialChecksum");
  requireChecksum(f.finalChecksum, "finalChecksum");
  const initialChecksum = checksum(initial);
  if (f.initialChecksum !== initialChecksum) throw invalid("initialChecksum does not match initialState");
  if (checksum(newGame(rules, f.seed)) !== initialChecksum) {
    throw invalid("initialState is not the new game for this seed and ruleset");
  }
  if (!Array.isArray(f.moves)) throw invalid("moves must be an array");
  requireMoveCount(f.moves.length);
  return { initial, moves: f.moves };
}

/**
 * Verifies a portable replay against `rules`: supported versions, initial state equal to
 * newGame(rules, seed) with a matching initialChecksum, every listed move changes the board and
 * reproduces its recorded revision and checksum, and finalChecksum matches. Never throws; failures
 * report the EngineErrorCode and the 0-based move index (null for file-level problems).
 */
export function verifyReplay(file: ReplayFile, rules: Ruleset): VerifyReplayResult {
  let initial: GameState;
  let moves: unknown[];
  try {
    ({ initial, moves } = verifyHeader(file, rules));
  } catch (error) {
    if (error instanceof EngineError) return fail(error.code, null, error.message);
    return fail("VALIDATION_ERROR", null, "replay could not be read");
  }

  let state = initial;
  for (let i = 0; i < moves.length; i += 1) {
    try {
      const move = moves[i];
      if (typeof move !== "object" || move === null) throw invalid("move must be an object");
      const { direction, revision, checksum: recorded } = move as Record<string, unknown>;
      requireDirection(direction);
      requireChecksum(recorded, "move checksum");
      const result = applyMove(state, direction, rules);
      if (!result.changed) throw invalid("replay contains a move that does not change the board");
      if (revision !== result.state.revision) throw invalid("move revision does not match");
      if (recorded !== checksum(result.state)) throw invalid("move checksum does not match");
      state = result.state;
    } catch (error) {
      if (error instanceof EngineError) return fail(error.code, i, error.message);
      return fail("VALIDATION_ERROR", i, "move could not be verified");
    }
  }

  if ((file as { finalChecksum: unknown }).finalChecksum !== checksum(state)) {
    return fail("VALIDATION_ERROR", null, "finalChecksum does not match the replayed state");
  }
  return { ok: true, final: state };
}
