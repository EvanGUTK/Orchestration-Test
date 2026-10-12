/**
 * The ONLY module in apps/web that imports @g2048/engine (CONTRACT-001 Engine public API).
 * Everything else depends on the EnginePort type so tests can substitute a scripted double and the
 * browser never grows a second implementation of the 2048 rules.
 */
import { applyMove, deserialize, legalMoves, newGame, serialize } from "@g2048/engine";
import type { EnginePort } from "./engine-port.js";

export const localEngine: EnginePort = { newGame, applyMove, legalMoves, serialize, deserialize };

export function loadLocalEngine(): EnginePort {
  return localEngine;
}
