import {
  DomainError, ENGINE_VERSION, PRNG_ALGORITHM, SEED_NAMESPACE, STATE_SCHEMA_VERSION,
} from "@2048/contracts";
import type { Cell, Direction, DomainEvent, GameState, MoveResult, Ruleset } from "@2048/contracts";
import { Xoshiro, deriveSeedWords } from "./prng.ts";
import { isDeadBoard, isDirection, maxExponentOf, slideCore, slideEvents } from "./slide.ts";
import { assertGameState, assertRules } from "./validate.ts";

const MILESTONE_EXPONENT = 11n; // tile 2048

function spawnInto(cells: Cell[], rng: Xoshiro, rules: Ruleset): { index: number; exponent: string } {
  const empties: number[] = [];
  for (let i = 0; i < cells.length; i++) if (cells[i] === null) empties.push(i);
  if (empties.length === 0) throw new DomainError("INTERNAL_ERROR", "no empty cell available for spawn");
  const index = empties[rng.below(empties.length)] as number;
  const exponent = rng.below(10) < rules.spawnFourTenths ? "2" : "1";
  cells[index] = exponent;
  return { index, exponent };
}

export function newGame(rules: Ruleset, seed: string): GameState {
  assertRules(rules);
  if (typeof seed !== "string") throw new DomainError("VALIDATION_ERROR", "seed must be a string");
  const rng = new Xoshiro(deriveSeedWords(seed, SEED_NAMESPACE));
  const cells: Cell[] = new Array<Cell>(rules.boardSize * rules.boardSize).fill(null);
  for (let i = 0; i < rules.startTiles; i++) spawnInto(cells, rng, rules);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: rules.version,
    board: { size: rules.boardSize, cells },
    score: "0",
    acceptedMoves: 0,
    revision: 0,
    rng: { algorithm: PRNG_ALGORITHM, words: rng.words() },
    status: "active",
    celebrated2048: false,
  };
}

export function applyMove(state: GameState, direction: Direction, rules: Ruleset): MoveResult {
  assertGameState(state);
  assertRules(rules);
  if (state.rulesetVersion !== rules.version || state.board.size !== rules.boardSize) {
    throw new DomainError("VALIDATION_ERROR", "state does not match the supplied ruleset");
  }
  if (!isDirection(direction)) throw new DomainError("VALIDATION_ERROR", "invalid direction");
  if (state.status !== "active") throw new DomainError("FORBIDDEN", `game is ${state.status}`);

  const size = state.board.size;
  const core = slideCore(state.board.cells, size, direction);
  if (!core.changed) return { state, changed: false, scoreDelta: "0", events: [] };

  if (state.acceptedMoves >= Number.MAX_SAFE_INTEGER || state.revision >= Number.MAX_SAFE_INTEGER) {
    throw new DomainError("RESOURCE_LIMIT", "move counter limit reached");
  }

  const events: DomainEvent[] = slideEvents(state.board.cells, core.next, size);
  const rng = new Xoshiro(state.rng.words);
  const next = core.next;
  const spawned = spawnInto(next, rng, rules);
  events.push({ type: "spawn", index: spawned.index, exponent: spawned.exponent });

  const prevMax = maxExponentOf(state.board.cells);
  const newMax = maxExponentOf(next);
  let celebrated = state.celebrated2048;
  if (newMax !== prevMax && BigInt(newMax) >= MILESTONE_EXPONENT) {
    const hi = BigInt(newMax);
    let e = BigInt(prevMax) + 1n;
    if (e < MILESTONE_EXPONENT) e = MILESTONE_EXPONENT;
    for (; e <= hi; e++) {
      events.push({ type: "milestone", exponent: e.toString() });
      if (e === MILESTONE_EXPONENT) celebrated = true;
    }
  }

  const acceptedMoves = state.acceptedMoves + 1;
  const dead = isDeadBoard(next, size);
  const capped = rules.moveCap !== null && acceptedMoves >= rules.moveCap;
  if (dead) events.push({ type: "game-over" });
  else if (capped) events.push({ type: "move-cap" });

  const score = (BigInt(state.score) + core.delta).toString();
  if (score.length > 4_000_000) throw new DomainError("RESOURCE_LIMIT", "score exceeds the maximum supported size");

  return {
    state: {
      schemaVersion: STATE_SCHEMA_VERSION,
      engineVersion: state.engineVersion,
      rulesetVersion: state.rulesetVersion,
      board: { size, cells: next },
      score,
      acceptedMoves,
      revision: state.revision + 1,
      rng: { algorithm: PRNG_ALGORITHM, words: rng.words() },
      status: dead || capped ? "completed" : "active",
      celebrated2048: celebrated,
    },
    changed: true,
    scoreDelta: core.delta.toString(),
    events,
  };
}
