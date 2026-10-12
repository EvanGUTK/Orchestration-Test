// Contract-typed view of the PUBLIC @g2048/engine API (CONTRACT-001 "Engine public API").
// Written from packages/contracts/CONTRACT-001.md only; quality never reads packages/engine/src.
// The namespace import is re-typed against the contract so these tests compile before the
// engine lands; ENG-API (below, in eng-10) asserts at runtime that every name is exported.
import * as engineModule from "@g2048/engine";
import type {
  Board,
  Decimal,
  Direction,
  EngineErrorCode,
  Exponent,
  GameState,
  MoveResult,
  RandomState,
  ReplayFile,
  Ruleset,
  SlideResult,
} from "@g2048/contracts";

export interface EngineErrorLike extends Error {
  readonly code: EngineErrorCode;
}

export type VerifyReplayResult =
  | { ok: true; final: GameState }
  | { ok: false; code: EngineErrorCode; atMove: number | null; message: string };

export interface EngineApi {
  EngineError: abstract new (...args: never[]) => EngineErrorLike;
  newGame(rules: Ruleset, seed: string): GameState;
  slide(board: Board, direction: Direction): SlideResult;
  applyMove(state: GameState, direction: Direction, rules: Ruleset): MoveResult;
  forfeit(state: GameState): GameState;
  legalMoves(board: Board): Direction[];
  isGameOver(board: Board): boolean;
  maxExponent(board: Board): Exponent | null;
  canonicalJson(state: GameState): string;
  checksum(state: GameState): string;
  serialize(state: GameState): string;
  deserialize(json: string): GameState;
  deriveRandomState(namespace: string, seed: string): RandomState;
  nextUint32(rng: RandomState): [number, RandomState];
  uniform(rng: RandomState, n: number): [number, RandomState];
  replay(
    initial: GameState,
    moves: readonly Direction[],
    rules: Ruleset,
  ): { final: GameState; checksums: string[] };
  verifyReplay(file: ReplayFile, rules: Ruleset): VerifyReplayResult;
  compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1;
  addDecimal(a: Decimal, b: Decimal): Decimal;
  pow2Decimal(e: Exponent): Decimal;
}

export const CONTRACT_EXPORTS = [
  "EngineError",
  "newGame",
  "slide",
  "applyMove",
  "forfeit",
  "legalMoves",
  "isGameOver",
  "maxExponent",
  "canonicalJson",
  "checksum",
  "serialize",
  "deserialize",
  "deriveRandomState",
  "nextUint32",
  "uniform",
  "replay",
  "verifyReplay",
  "compareDecimal",
  "addDecimal",
  "pow2Decimal",
] as const satisfies readonly (keyof EngineApi)[];

export const engineExports = engineModule as unknown as Record<string, unknown>;
export const E = engineModule as unknown as EngineApi;
