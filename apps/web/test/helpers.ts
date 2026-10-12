import type { Cell, GameState } from "@2048/contracts";
import { CLASSIC_RULES, ENGINE_VERSION } from "@2048/contracts";

export function makeState(cells: Cell[], overrides: Partial<GameState> = {}, size = 4): GameState {
  const padded = [...cells, ...new Array<Cell>(size * size - cells.length).fill(null)];
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: CLASSIC_RULES.version,
    board: { size, cells: padded },
    score: "0",
    acceptedMoves: 0,
    revision: 0,
    rng: { algorithm: "xoshiro128ss-v1", words: [1, 2, 3, 4] },
    status: "active",
    celebrated2048: false,
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
