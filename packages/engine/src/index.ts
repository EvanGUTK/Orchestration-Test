// @g2048/engine — pure, deterministic 2048 Infinite engine (CONTRACT-001 / v1).
export { EngineError, isEngineError } from "./errors.js";
export { addDecimal, compareDecimal, isDecimal, isExponent, MAX_EXPONENT, pow2Decimal } from "./decimal.js";
export { canMove, isDirection, isGameOver, legalMoves, maxExponent, slide, validateBoard } from "./slide.js";
export { sha256, sha256Hex, toHex, utf8Bytes } from "./sha256.js";
export { deriveRandomState, nextUint32, uniform, validateRandomState, wordsFromDigest } from "./rng.js";
export { MAX_SCORE_DIGITS, validateGameState, validateRuleset, VERSION_ID_PATTERN } from "./state.js";
export { applyMove, forfeit, MAX_SEED_LENGTH, newGame, spawn } from "./game.js";
