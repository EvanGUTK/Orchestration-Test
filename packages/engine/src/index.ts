// @g2048/engine — pure, deterministic 2048 Infinite engine (CONTRACT-001 / v1).
export { EngineError, isEngineError } from "./errors.js";
export { addDecimal, compareDecimal, isDecimal, isExponent, MAX_EXPONENT, pow2Decimal } from "./decimal.js";
export { canMove, isDirection, isGameOver, legalMoves, maxExponent, slide, validateBoard } from "./slide.js";
