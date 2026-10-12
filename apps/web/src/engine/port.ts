import type { Board, Direction, GameState, MoveResult, Ruleset, SlideResult } from "@2048/contracts";
import * as engineModule from "@2048/engine";

/**
 * Thin local adapter over `@2048/engine` (CONTRACT-001 public API).
 * The engine package is being written concurrently; the namespace import plus
 * structural cast keeps this workspace compiling before and after it lands.
 */
export type EnginePort = {
  newGame(rules: Ruleset, seed: string): GameState;
  slide(board: Board, direction: Direction): SlideResult;
  applyMove(state: GameState, direction: Direction, rules: Ruleset): MoveResult;
  legalMoves(board: Board): Direction[];
  isGameOver(board: Board): boolean;
  serialize(state: GameState): string;
  deserialize(json: string): GameState;
  validateState(state: unknown): GameState;
  stateChecksum(state: GameState): string;
  replay(
    initial: GameState,
    moves: Direction[],
    rules: Ruleset,
  ): { state: GameState; steps: { direction: Direction; changed: boolean; checksum: string }[] };
};

let current: EnginePort | null = null;

function fromModule(): EnginePort | null {
  const candidate = engineModule as unknown as Partial<EnginePort>;
  if (typeof candidate.newGame === "function" && typeof candidate.applyMove === "function") {
    return candidate as EnginePort;
  }
  return null;
}

export class EngineUnavailableError extends Error {
  constructor() {
    super("The game engine is not available in this build.");
    this.name = "EngineUnavailableError";
  }
}

/** Test seam: replace the engine implementation (pass null to restore the real module). */
export function setEnginePort(port: EnginePort | null): void {
  current = port;
}

export function isEngineAvailable(): boolean {
  return current !== null || fromModule() !== null;
}

export function getEngine(): EnginePort {
  const port = current ?? fromModule();
  if (!port) throw new EngineUnavailableError();
  return port;
}
