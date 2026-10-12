import {
  ENGINE_VERSION,
  MILESTONE_2048_EXPONENT,
  RNG_ALGORITHM,
  SCHEMA_VERSION,
  SEED_NAMESPACE,
} from "@g2048/contracts";
import type {
  Board,
  Cell,
  Direction,
  DomainEvent,
  Exponent,
  GameState,
  MoveResult,
  RandomState,
  Ruleset,
} from "@g2048/contracts";
import { addCanonical, compareCanonical, nextExponent } from "./decimal.js";
import { EngineError, invalid } from "./errors.js";
import { deriveRandomState, uniformStep, validateRandomState } from "./rng.js";
import type { Words } from "./rng.js";
import { isDead, maxExponentOf, requireDirection, slideCells, validateBoard } from "./slide.js";
import { requireMatchingRuleset, validateGameState, validateRuleset } from "./state.js";

const MILESTONE: Exponent = MILESTONE_2048_EXPONENT.toString();
/** Max seed length accepted by newGame (UTF-16 code units). */
export const MAX_SEED_LENGTH = 1024;

/**
 * Spawn on mutable cells/words (CONTRACT-001 decision 4): empty indexes row-major, position draw
 * uniform(emptyCount), then value draw uniform(10); exponent "2" if v < fourWeight else "1".
 */
function spawnInto(
  size: number,
  cells: Cell[],
  s: Words,
  fourWeight: number,
): { at: number; exponent: Exponent } {
  let empty = 0;
  for (const cell of cells) if (cell === null) empty += 1;
  if (empty === 0) throw invalid("cannot spawn on a full board");
  let target = uniformStep(s, empty);
  let at = -1;
  for (let i = 0; i < size * size; i += 1) {
    if (cells[i] === null) {
      if (target === 0) {
        at = i;
        break;
      }
      target -= 1;
    }
  }
  const exponent: Exponent = uniformStep(s, 10) < fourWeight ? "2" : "1";
  cells[at] = exponent;
  return { at, exponent };
}

/** One spawn on a board, returning the new board, advanced rng, and the placed tile. Inputs are not mutated. */
export function spawn(
  board: Board,
  rng: RandomState,
  fourWeight: number,
): { board: Board; rng: RandomState; at: number; exponent: Exponent } {
  validateBoard(board);
  validateRandomState(rng);
  if (typeof fourWeight !== "number" || !Number.isInteger(fourWeight) || fourWeight < 0 || fourWeight > 10) {
    throw invalid("fourWeight must be an integer in 0..10");
  }
  const cells = board.cells.slice();
  const s: Words = [rng.words[0], rng.words[1], rng.words[2], rng.words[3]];
  const { at, exponent } = spawnInto(board.size, cells, s, fourWeight);
  return { board: { size: board.size, cells }, rng: { algorithm: RNG_ALGORITHM, words: s }, at, exponent };
}

/** New game: empty board, rng = derive(SEED_NAMESPACE, seed), two spawns; rulesetVersion = rules.version. */
export function newGame(rules: Ruleset, seed: string): GameState {
  validateRuleset(rules);
  if (typeof seed !== "string" || seed.length > MAX_SEED_LENGTH) {
    throw invalid(`seed must be a string of at most ${MAX_SEED_LENGTH} characters`);
  }
  const rng = deriveRandomState(SEED_NAMESPACE, seed);
  const s: Words = [rng.words[0], rng.words[1], rng.words[2], rng.words[3]];
  const cells: Cell[] = new Array<Cell>(rules.size * rules.size).fill(null);
  spawnInto(rules.size, cells, s, rules.fourWeight);
  spawnInto(rules.size, cells, s, rules.fourWeight);
  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: rules.version,
    board: { size: rules.size, cells },
    score: "0",
    acceptedMoves: 0,
    revision: 0,
    rng: { algorithm: RNG_ALGORITHM, words: s },
    status: "active",
    celebrated2048: false,
  };
}

/** Milestone events for exponents in (prevMax, newMax] that are >= 11, ascending. */
function milestoneEvents(
  prevMax: Exponent | null,
  newMax: Exponent | null,
  flipsCelebration: boolean,
): DomainEvent[] {
  if (newMax === null || compareCanonical(newMax, MILESTONE) < 0) return [];
  if (prevMax !== null && compareCanonical(newMax, prevMax) <= 0) return [];
  let exponent = prevMax === null ? MILESTONE : nextExponent(prevMax);
  if (compareCanonical(exponent, MILESTONE) < 0) exponent = MILESTONE;
  const events: DomainEvent[] = [];
  for (;;) {
    events.push({ type: "milestone.reached", exponent, first2048: flipsCelebration && events.length === 0 });
    if (compareCanonical(exponent, newMax) >= 0) return events;
    exponent = nextExponent(exponent);
  }
}

/**
 * Applies one move (CONTRACT-001 decision 6). A changed move slides, adds the score, spawns once,
 * increments acceptedMoves and revision, then on the post-spawn board sets celebrated2048 once any
 * exponent >= 11 and completes the game when the board is dead or the move cap is reached.
 * A no-op returns the same state, changed:false, scoreDelta "0", no events, and consumes no draws.
 * Throws GAME_NOT_ACTIVE for a non-active game, VALIDATION_ERROR for malformed input or a ruleset
 * that does not match the state, RESOURCE_LIMIT before creating an exponent above LIMITS.maxExponent.
 */
export function applyMove(state: GameState, direction: Direction, rules: Ruleset): MoveResult {
  validateGameState(state);
  validateRuleset(rules);
  requireMatchingRuleset(state, rules);
  requireDirection(direction);
  if (state.status !== "active") {
    throw new EngineError("GAME_NOT_ACTIVE", `game is ${state.status}`);
  }
  if (state.revision >= Number.MAX_SAFE_INTEGER || state.acceptedMoves >= Number.MAX_SAFE_INTEGER) {
    throw new EngineError("RESOURCE_LIMIT", "move counters exhausted");
  }

  const { size } = state.board;
  const slid = slideCells(size, state.board.cells, direction);
  if (!slid.changed) return { state, changed: false, scoreDelta: "0", events: [] };

  const cells = slid.board.cells as Cell[]; // freshly allocated by slideCells; safe to fill in place
  const words = state.rng.words;
  const s: Words = [words[0], words[1], words[2], words[3]];
  const spawned = spawnInto(size, cells, s, rules.fourWeight);

  const acceptedMoves = state.acceptedMoves + 1;
  const prevMax = maxExponentOf(state.board.cells);
  const newMax = maxExponentOf(cells);
  const celebrated2048 =
    state.celebrated2048 || (newMax !== null && compareCanonical(newMax, MILESTONE) >= 0);
  const dead = isDead(size, cells);
  const capped = rules.moveCap !== null && acceptedMoves >= rules.moveCap;

  const events = slid.events as DomainEvent[]; // fresh array owned by this call
  events.push({ type: "tile.spawned", at: spawned.at, exponent: spawned.exponent });
  for (const event of milestoneEvents(prevMax, newMax, celebrated2048 && !state.celebrated2048))
    events.push(event);
  if (dead) events.push({ type: "game.over" });

  return {
    state: {
      schemaVersion: state.schemaVersion,
      engineVersion: state.engineVersion,
      rulesetVersion: state.rulesetVersion,
      board: { size, cells },
      score: addCanonical(state.score, slid.scoreDelta),
      acceptedMoves,
      revision: state.revision + 1,
      rng: { algorithm: RNG_ALGORITHM, words: s },
      status: dead || capped ? "completed" : "active",
      celebrated2048,
    },
    changed: true,
    scoreDelta: slid.scoreDelta,
    events,
  };
}

/**
 * Forfeits an active game: status "forfeited"; board, score, counters, revision and rng unchanged.
 * Throws GAME_NOT_ACTIVE if the game is already completed or forfeited.
 */
export function forfeit(state: GameState): GameState {
  validateGameState(state);
  if (state.status !== "active") {
    throw new EngineError("GAME_NOT_ACTIVE", `game is ${state.status}`);
  }
  return {
    schemaVersion: state.schemaVersion,
    engineVersion: state.engineVersion,
    rulesetVersion: state.rulesetVersion,
    board: { size: state.board.size, cells: state.board.cells.slice() },
    score: state.score,
    acceptedMoves: state.acceptedMoves,
    revision: state.revision,
    rng: { algorithm: state.rng.algorithm, words: [...state.rng.words] as Words },
    status: "forfeited",
    celebrated2048: state.celebrated2048,
  };
}
