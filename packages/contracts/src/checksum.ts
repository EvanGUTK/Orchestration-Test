import type { GameState } from "./state.ts";

/**
 * Canonical state serialization for checksums (CHECKSUM_VERSION 1).
 * Key order is exactly the GameState declaration order; no whitespace; cells row-major
 * with `null` for empty and exponent decimal STRINGS; PRNG words as JSON numbers.
 * checksum = lowercase hex SHA-256 over the UTF-8 bytes of this string.
 * Excludes preferences, usernames, clocks, animation. The engine owns the SHA-256 implementation.
 */
export function canonicalStateJson(state: GameState): string {
  const cells = state.board.cells.map((c) => (c === null ? "null" : JSON.stringify(c))).join(",");
  return (
    `{"schemaVersion":${state.schemaVersion},` +
    `"engineVersion":${JSON.stringify(state.engineVersion)},` +
    `"rulesetVersion":${JSON.stringify(state.rulesetVersion)},` +
    `"board":{"size":${state.board.size},"cells":[${cells}]},` +
    `"score":${JSON.stringify(state.score)},` +
    `"acceptedMoves":${state.acceptedMoves},` +
    `"revision":${state.revision},` +
    `"rng":{"algorithm":${JSON.stringify(state.rng.algorithm)},"words":[${state.rng.words.join(",")}]},` +
    `"status":${JSON.stringify(state.status)},` +
    `"celebrated2048":${state.celebrated2048}}`
  );
}
