import type { RNG_ALGORITHM, SCHEMA_VERSION } from "./versions.js";

/** Canonical nonnegative base-10 integer string: /^0$|^[1-9][0-9]*$/. Never a JS number. */
export type Decimal = string;
/** Positive Decimal; tile value is 2 ** exponent. "1" = 2, "2" = 4, "11" = 2048. */
export type Exponent = string;
export type Cell = Exponent | null;
export type Direction = "up" | "right" | "down" | "left";
/** Stable order used by legalMoves() and anywhere directions are enumerated. */
export const DIRECTIONS: readonly Direction[] = ["up", "right", "down", "left"];

/** Row-major cells, length size*size, index = row*size + col. */
export type Board = { readonly size: number; readonly cells: readonly Cell[] };
export type RandomState = {
  readonly algorithm: typeof RNG_ALGORITHM;
  readonly words: readonly [number, number, number, number];
};
export type GameStatus = "active" | "completed" | "forfeited";

/** Field order here IS the canonical JSON key order used for checksums (see CANONICAL_STATE_KEYS). */
export type GameState = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly engineVersion: string;
  readonly rulesetVersion: string;
  readonly board: Board;
  readonly score: Decimal;
  readonly acceptedMoves: number;
  readonly revision: number;
  readonly rng: RandomState;
  readonly status: GameStatus;
  readonly celebrated2048: boolean;
};

export const CANONICAL_STATE_KEYS = [
  "schemaVersion",
  "engineVersion",
  "rulesetVersion",
  "board",
  "score",
  "acceptedMoves",
  "revision",
  "rng",
  "status",
  "celebrated2048",
] as const;
export const CANONICAL_BOARD_KEYS = ["size", "cells"] as const;
export const CANONICAL_RNG_KEYS = ["algorithm", "words"] as const;

/**
 * Domain events, emitted in this order within one move:
 *  1. tile.moved   — every source tile whose index changes, sorted by destination index asc, then source index asc
 *                    (both sources of a merge emit tile.moved when they change position)
 *  2. tile.merged  — sorted by destination index asc
 *  3. tile.spawned — exactly one on a changed move (two in newGame, in draw order)
 *  4. milestone.reached — when the board's max exponent rises above its previous max and is >= 11, ascending
 *  5. game.over    — if the resulting board has no empty cell and no adjacent equal exponents
 */
export type DomainEvent =
  | { readonly type: "tile.moved"; readonly from: number; readonly to: number; readonly exponent: Exponent }
  | {
      readonly type: "tile.merged";
      readonly to: number;
      readonly sources: readonly [number, number];
      readonly exponent: Exponent; // resulting exponent
      readonly value: Decimal; // 2 ** exponent, added to score
    }
  | { readonly type: "tile.spawned"; readonly at: number; readonly exponent: Exponent }
  | { readonly type: "milestone.reached"; readonly exponent: Exponent; readonly first2048: boolean }
  | { readonly type: "game.over" };

export type SlideResult = {
  readonly board: Board;
  readonly changed: boolean;
  readonly scoreDelta: Decimal;
  readonly events: readonly DomainEvent[]; // tile.moved + tile.merged only
};

export type MoveCommand = {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly direction: Direction;
};
export type MoveResult = {
  readonly state: GameState;
  readonly changed: boolean;
  readonly scoreDelta: Decimal;
  readonly events: readonly DomainEvent[];
};

/** Typed engine failures. Engine functions never throw raw errors for invalid input. */
export type EngineErrorCode =
  "VALIDATION_ERROR" | "RESOURCE_LIMIT" | "REPLAY_VERSION_UNSUPPORTED" | "GAME_NOT_ACTIVE";
