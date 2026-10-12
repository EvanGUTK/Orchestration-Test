import type {
  Board,
  Direction,
  Exponent,
  GameState,
  MoveResult,
  RandomState,
  Ruleset,
  SlideResult,
} from "@g2048/contracts";

/**
 * The narrow slice of @g2048/engine (CONTRACT-001 "Engine public API") that bots use.
 * Strategies search with the engine's own pure `slide`, so the bot simulator runs the same
 * transition as the backend and replay checker. Bots never call `applyMove` while searching;
 * only the runner / tournament (which play real games) do. The engine package itself
 * satisfies this interface structurally.
 */
export interface EnginePort {
  slide(board: Board, direction: Direction): SlideResult;
  legalMoves(board: Board): Direction[];
  isGameOver(board: Board): boolean;
  maxExponent(board: Board): Exponent | null;
  deriveRandomState(namespace: string, seed: string): RandomState;
  uniform(rng: RandomState, n: number): [number, RandomState];
  newGame(rules: Ruleset, seed: string): GameState;
  applyMove(state: GameState, direction: Direction, rules: Ruleset): MoveResult;
}
