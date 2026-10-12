import type { Cell, GameState } from "@2048/contracts";
import { CLASSIC_RULES, ENGINE_VERSION } from "@2048/contracts";

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

export function makeState(cells: Cell[], overrides: Partial<GameState> = {}, size = 4): GameState {
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: CLASSIC_RULES.version,
    board: { size, cells },
    score: "0",
    acceptedMoves: 0,
    revision: 0,
    rng: { algorithm: "xoshiro128ss-v1", words: [1, 2, 3, 4] },
    status: "active",
    celebrated2048: false,
    ...overrides,
  };
}

/** Pads a row-major prefix with empties up to 16 cells. */
export function board16(prefix: Cell[]): Cell[] {
  return [...prefix, ...new Array<Cell>(16 - prefix.length).fill(null)];
}
