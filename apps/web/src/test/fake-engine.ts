import { ENGINE_VERSION, RNG_ALGORITHM, SCHEMA_VERSION } from "@g2048/contracts";
import type { Board, Direction, DomainEvent, GameState, MoveResult, Ruleset } from "@g2048/contracts";
import type { EnginePort } from "../game/engine-port.js";

/**
 * Scripted test double for the engine port. It does NOT implement 2048 rules (the real engine is the
 * only implementation); it records every applied direction and returns whatever the script says, so UI
 * tests can check ordering, no-ops, milestones and game over deterministically.
 */
export type ScriptStep = {
  changed?: boolean;
  events?: DomainEvent[];
  board?: Board;
  status?: GameState["status"];
  scoreDelta?: string;
  throwCode?: string;
};

export type FakeEngine = EnginePort & {
  readonly calls: Direction[];
  script: (direction: Direction, state: GameState, callIndex: number) => ScriptStep;
};

export function fakeState(rules: Ruleset, overrides: Partial<GameState> = {}): GameState {
  const cells = Array.from({ length: rules.size * rules.size }, () => null as string | null);
  cells[0] = "1";
  cells[1] = "1";
  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: rules.version,
    board: { size: rules.size, cells },
    score: "0",
    acceptedMoves: 0,
    revision: 0,
    rng: { algorithm: RNG_ALGORITHM, words: [1, 0, 0, 0] },
    status: "active",
    celebrated2048: false,
    ...overrides,
  };
}

export function createFakeEngine(): FakeEngine {
  const calls: Direction[] = [];
  const engine: FakeEngine = {
    calls,
    script: () => ({}),
    newGame(rules: Ruleset, seed: string) {
      void seed;
      return fakeState(rules);
    },
    applyMove(state: GameState, direction: Direction, rules: Ruleset): MoveResult {
      void rules;
      if (state.status !== "active")
        throw Object.assign(new Error("not active"), { code: "GAME_NOT_ACTIVE" });
      const step = engine.script(direction, state, calls.length);
      if (step.throwCode) throw Object.assign(new Error(step.throwCode), { code: step.throwCode });
      calls.push(direction);
      if (step.changed === false) return { state, changed: false, scoreDelta: "0", events: [] };
      const delta = step.scoreDelta ?? "4";
      const events = step.events ?? [{ type: "tile.spawned", at: 2, exponent: "1" }];
      const next: GameState = {
        ...state,
        board: step.board ?? state.board,
        score: (BigInt(state.score) + BigInt(delta)).toString(),
        acceptedMoves: state.acceptedMoves + 1,
        revision: state.revision + 1,
        status: step.status ?? "active",
        celebrated2048:
          state.celebrated2048 || events.some((e) => e.type === "milestone.reached" && e.first2048),
      };
      return { state: next, changed: true, scoreDelta: delta, events };
    },
    legalMoves: () => ["up", "right", "down", "left"],
    forfeit: (state) => ({ ...state, status: "forfeited" }),
    checksum: (state) => `fake-${state.revision}-${state.score}`,
    replay: () => {
      throw Object.assign(new Error("not supported by the fake engine"), { code: "VALIDATION_ERROR" });
    },
    verifyReplay: () => ({ ok: false, code: "VALIDATION_ERROR", atMove: null, message: "fake engine" }),
    serialize: (state) => JSON.stringify(state),
    deserialize(json: string) {
      const value = JSON.parse(json) as GameState;
      if (value.schemaVersion !== SCHEMA_VERSION || !value.board) {
        throw Object.assign(new Error("bad state"), { code: "VALIDATION_ERROR" });
      }
      return value;
    },
  };
  return engine;
}

export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}
