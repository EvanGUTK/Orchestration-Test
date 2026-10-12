import {
  applyMove,
  deriveRandomState,
  isGameOver,
  legalMoves,
  maxExponent,
  newGame,
  slide,
  uniform,
} from "@g2048/engine";
import type { EnginePort } from "./engine-port.js";

/** The real @g2048/engine behind the EnginePort interface. */
export const engineAdapter: EnginePort = {
  slide,
  legalMoves,
  isGameOver,
  maxExponent,
  deriveRandomState,
  uniform,
  newGame,
  applyMove,
};
