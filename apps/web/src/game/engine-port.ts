import type { Board, Direction, GameState, MoveResult, Ruleset } from "@g2048/contracts";

/**
 * The subset of the CONTRACT-001 engine API (`@g2048/engine`) that the browser uses for guest play.
 * Everything in apps/web depends on this port, never on the engine module directly; only
 * `local-engine.ts` imports `@g2048/engine`. Tests pass a scripted double.
 */
export type EnginePort = {
  newGame(rules: Ruleset, seed: string): GameState;
  applyMove(state: GameState, direction: Direction, rules: Ruleset): MoveResult;
  legalMoves(board: Board): Direction[];
  /** Ends an active game: status "forfeited", same score/rng. */
  forfeit(state: GameState): GameState;
  serialize(state: GameState): string;
  /** Validates; throws an EngineError-shaped value ({ code }) on bad input/version. */
  deserialize(json: string): GameState;
};

export type EngineFailure = { code: string; message: string };

/** Normalizes anything thrown by the engine into a typed failure without leaking stack traces. */
export function toEngineFailure(error: unknown): EngineFailure {
  if (typeof error === "object" && error !== null) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
    const message = "message" in error && typeof error.message === "string" ? error.message : "Engine error";
    return { code, message };
  }
  return { code: "INTERNAL_ERROR", message: "Engine error" };
}
