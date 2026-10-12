import type { Cell, Decimal, Exponent } from "./exact.ts";

export type Direction = "up" | "right" | "down" | "left";
export const DIRECTIONS: readonly Direction[] = ["up", "right", "down", "left"]; // stable legalMoves order

export type Board = { size: number; cells: readonly Cell[] }; // row-major, length = size*size
export type RandomState = { algorithm: "xoshiro128ss-v1"; words: [number, number, number, number] };

export type GameStatus = "active" | "completed" | "forfeited";

export type GameState = {
  schemaVersion: 1;
  engineVersion: string;
  rulesetVersion: string;
  board: Board;
  score: Decimal;
  acceptedMoves: number;
  revision: number;
  rng: RandomState;
  status: GameStatus;
  celebrated2048: boolean;
};

export type MoveCommand = { commandId: string; expectedRevision: number; direction: Direction };

/**
 * Event order for one accepted move (frozen):
 * 1. every `move` in destination row-major order (merge sources: leading tile first),
 * 2. every `merge` in destination row-major order,
 * 3. exactly one `spawn`,
 * 4. `milestone` events with ascending exponent,
 * 5. `game-over` (dead board) or `move-cap` (acceptedMoves reached ruleset.moveCap).
 * Indexes are row-major cell indexes in the board BEFORE (from) / AFTER (to) the slide.
 */
export type DomainEvent =
  | { type: "move"; from: number; to: number; exponent: Exponent }
  | { type: "merge"; sources: [number, number]; to: number; exponent: Exponent; value: Decimal }
  | { type: "spawn"; index: number; exponent: Exponent }
  | { type: "milestone"; exponent: Exponent }
  | { type: "game-over" }
  | { type: "move-cap" };

export type MoveResult = {
  state: GameState;
  changed: boolean;
  scoreDelta: Decimal;
  events: DomainEvent[];
};

/** Result of the pure, randomness-free slide. */
export type SlideResult = {
  board: Board;
  changed: boolean;
  scoreDelta: Decimal;
  events: DomainEvent[]; // `move` then `merge` events only
};

export function emptyIndexes(board: Board): number[] {
  const out: number[] = [];
  for (let i = 0; i < board.cells.length; i++) if (board.cells[i] === null) out.push(i);
  return out;
}
