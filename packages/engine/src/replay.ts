import { DomainError } from "@2048/contracts";
import type { Direction, GameState, Ruleset } from "@2048/contracts";
import { applyMove } from "./game.ts";
import { assertRules, checksumTrusted, validateState } from "./validate.ts";

/** Upper bound on moves in one replay call; larger inputs are RESOURCE_LIMIT. */
export const MAX_REPLAY_MOVES = 1_000_000;

export function replay(
  initial: GameState,
  moves: Direction[],
  rules: Ruleset,
): { state: GameState; steps: { direction: Direction; changed: boolean; checksum: string }[] } {
  assertRules(rules);
  if (!Array.isArray(moves)) throw new DomainError("VALIDATION_ERROR", "moves must be an array");
  if (moves.length > MAX_REPLAY_MOVES) {
    throw new DomainError("RESOURCE_LIMIT", "replay exceeds the maximum supported move count");
  }
  let state = validateState(initial);
  const steps: { direction: Direction; changed: boolean; checksum: string }[] = [];
  for (const direction of moves) {
    const r = applyMove(state, direction, rules);
    state = r.state;
    steps.push({ direction, changed: r.changed, checksum: checksumTrusted(state) });
  }
  return { state, steps };
}
