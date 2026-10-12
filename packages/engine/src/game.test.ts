import { readFileSync } from "node:fs";
import { practiceRuleset, RNG_ALGORITHM, RULESETS } from "@g2048/contracts";
import type { Cell, Direction, GameState, RandomState, Ruleset } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.js";
import { applyMove, forfeit, newGame, spawn } from "./game.js";
import { nextUint32 } from "./rng.js";
import { isGameOver, legalMoves } from "./slide.js";

type Words = [number, number, number, number];
type StateVec = { state: GameState; canonicalJson: string; checksum: string };
type Vectors = {
  newGame: {
    size: number;
    seed: string;
    initialWords: Words;
    spawns: {
      index: number;
      exponent: string;
      emptyCount: number;
      positionDraw: number;
      valueDraw: number;
    }[];
    state: GameState;
  }[];
  moveSequences: {
    seed: string;
    size: number;
    directions: Direction[];
    initial: StateVec;
    steps: {
      step: number;
      direction: Direction;
      changed: boolean;
      scoreDelta: string;
      spawn: { index: number; exponent: string } | null;
      rawDrawsConsumed: number;
      score: string;
      acceptedMoves: number;
      revision: number;
      status: string;
      rngWords: Words;
      checksum: string;
    }[];
    noOpSteps: number[];
    final: StateVec;
  }[];
  highValue: {
    direction: Direction;
    before: StateVec;
    slide: {
      cells: Cell[];
      changed: boolean;
      merges: { to: number; exponent: string; value: string }[];
      scoreDelta: string;
    };
    applyMove: {
      changed: boolean;
      scoreDelta: string;
      spawn: { index: number; exponent: string };
      after: StateVec;
    };
  };
  transitions: (
    | {
        id: string;
        direction: Direction;
        before: StateVec;
        changed: boolean;
        scoreDelta: string;
        after: StateVec;
      }
    | { id: string; board: { size: number; cells: Cell[] }; isGameOver: boolean; legalMoves: Direction[] }
  )[];
};

const vectors = JSON.parse(
  readFileSync(new URL("../../contracts/vectors/engine-v1.json", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  ),
) as Vectors;

const CLASSIC = RULESETS["classic-v1"];

function rulesFor(size: number): Ruleset {
  return size === 4 ? CLASSIC : practiceRuleset({ size, fourWeight: 1, undo: true });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof EngineError ? error.code : "RAW";
  }
}

function makeState(cells: Cell[], overrides: Partial<GameState> = {}): GameState {
  const size = Math.round(Math.sqrt(cells.length));
  return deepFreeze({
    schemaVersion: 1,
    engineVersion: "1.0.0",
    rulesetVersion: size === 4 ? "classic-v1" : "practice-v1",
    board: { size, cells },
    score: "0",
    acceptedMoves: 0,
    revision: 0,
    rng: { algorithm: RNG_ALGORITHM, words: [1, 2, 3, 4] },
    status: "active",
    celebrated2048: false,
    ...overrides,
  } as GameState);
}

function rawDraws(from: Words, to: readonly number[], max = 64): number {
  let rng: RandomState = { algorithm: RNG_ALGORITHM, words: from };
  for (let n = 0; n <= max; n += 1) {
    if (rng.words.every((w, i) => w === to[i])) return n;
    rng = nextUint32(rng)[1];
  }
  return -1;
}

const E = null;

describe("newGame vectors (ENG-04, ENG-10)", () => {
  it("covers sizes 3, 4, 8 x three seeds", () => expect(vectors.newGame).toHaveLength(9));
  for (const v of vectors.newGame) {
    it(`size ${v.size} seed ${JSON.stringify(v.seed)}`, () => {
      const rules = deepFreeze({ ...rulesFor(v.size) });
      const state = newGame(rules, v.seed);
      expect(state).toEqual(v.state);
      expect(Object.keys(state)).toEqual(Object.keys(v.state));
      const placed = v.spawns.map((s) => [s.index, s.exponent]);
      expect(state.board.cells.flatMap((c, i) => (c === null ? [] : [[i, c]]))).toEqual(
        placed.sort((a, b) => (a[0] as number) - (b[0] as number)),
      );
      expect(rawDraws(v.initialWords, state.rng.words)).toBe(4);
    });
  }

  it("labels a 4x4 practice game practice-v1 and honours fourWeight", () => {
    const practice = newGame(practiceRuleset({ size: 4, fourWeight: 10, undo: true }), "abc");
    expect(practice.rulesetVersion).toBe("practice-v1");
    expect(practice.board.cells.filter((c) => c !== null)).toEqual(["2", "2"]);
    const twos = newGame(practiceRuleset({ size: 4, fourWeight: 0, undo: true }), "abc");
    expect(twos.board.cells.filter((c) => c !== null)).toEqual(["1", "1"]);
  });

  it("rejects malformed rules and seeds", () => {
    expect(codeOf(() => newGame({ ...CLASSIC, size: 2 }, "x"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => newGame({ ...CLASSIC, fourWeight: 11 }, "x"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => newGame({ ...CLASSIC, fourWeight: 0.5 }, "x"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => newGame({ ...CLASSIC, moveCap: 0 }, "x"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => newGame({ ...CLASSIC, version: "" }, "x"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => newGame(CLASSIC, 42 as unknown as string))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => newGame(CLASSIC, "x".repeat(1025)))).toBe("VALIDATION_ERROR");
  });
});

describe("moveSequences vectors (ENG-03, ENG-04)", () => {
  for (const seq of vectors.moveSequences) {
    it(`seed ${JSON.stringify(seq.seed)}: ${seq.steps.length} steps`, () => {
      expect(newGame(CLASSIC, seq.seed)).toEqual(seq.initial.state);
      let state = deepFreeze(structuredClone(seq.initial.state));
      const noOps: number[] = [];
      for (const step of seq.steps) {
        const before = state;
        const snapshot = JSON.stringify(before);
        const result = applyMove(before, step.direction, CLASSIC);
        expect(JSON.stringify(before)).toBe(snapshot);
        expect(result.changed).toBe(step.changed);
        expect(result.scoreDelta).toBe(step.scoreDelta);
        expect(result.state.score).toBe(step.score);
        expect(result.state.acceptedMoves).toBe(step.acceptedMoves);
        expect(result.state.revision).toBe(step.revision);
        expect(result.state.status).toBe(step.status);
        expect(result.state.rng.words).toEqual(step.rngWords);
        expect(rawDraws(before.rng.words as Words, result.state.rng.words)).toBe(step.rawDrawsConsumed);
        const spawns = result.events.filter((e) => e.type === "tile.spawned");
        if (step.spawn === null) {
          noOps.push(step.step);
          expect(result.state).toBe(before);
          expect(result.events).toEqual([]);
        } else {
          expect(spawns).toEqual([
            { type: "tile.spawned", at: step.spawn.index, exponent: step.spawn.exponent },
          ]);
        }
        state = deepFreeze(result.state);
      }
      expect(noOps).toEqual(seq.noOpSteps);
      expect(state).toEqual(seq.final.state);
    });
  }
});

describe("highValue vector (ENG-05)", () => {
  const v = vectors.highValue;
  it("applyMove keeps exponents 54/4096 and a 1234-digit score exact", () => {
    const before = deepFreeze(structuredClone(v.before.state));
    const result = applyMove(before, v.direction, CLASSIC);
    expect(result.changed).toBe(true);
    expect(result.scoreDelta).toBe(v.applyMove.scoreDelta);
    expect(result.scoreDelta).toBe(((1n << 54n) + (1n << 4096n)).toString());
    expect(result.state).toEqual(v.applyMove.after.state);
    expect(result.events.find((e) => e.type === "tile.spawned")).toEqual({
      type: "tile.spawned",
      at: v.applyMove.spawn.index,
      exponent: v.applyMove.spawn.exponent,
    });
    const merges = result.events.filter((e) => e.type === "tile.merged");
    expect(merges.map((m) => ({ to: m.to, exponent: m.exponent, value: m.value }))).toEqual(v.slide.merges);
    // max exponent rises from 4095 to 4096: one milestone, and it is the first celebration.
    expect(result.events.filter((e) => e.type === "milestone.reached")).toEqual([
      { type: "milestone.reached", exponent: "4096", first2048: true },
    ]);
  });
});

describe("transition vectors (ENG-06, ENG-07)", () => {
  for (const t of vectors.transitions) {
    it(t.id, () => {
      if ("board" in t) {
        expect(isGameOver(t.board)).toBe(t.isGameOver);
        expect(legalMoves(t.board)).toEqual(t.legalMoves);
        return;
      }
      const result = applyMove(deepFreeze(structuredClone(t.before.state)), t.direction, CLASSIC);
      expect(result.changed).toBe(t.changed);
      expect(result.scoreDelta).toBe(t.scoreDelta);
      expect(result.state).toEqual(t.after.state);
      const types = result.events.map((e) => e.type);
      if (t.after.state.status === "completed") expect(types.at(-1)).toBe("game.over");
      if (t.after.state.celebrated2048 && !t.before.state.celebrated2048) {
        expect(result.events).toContainEqual({ type: "milestone.reached", exponent: "11", first2048: true });
      }
      if (t.before.state.celebrated2048) {
        expect(result.events.filter((e) => e.type === "milestone.reached").every((e) => !e.first2048)).toBe(
          true,
        );
      }
    });
  }
});

describe("applyMove events and lifecycle", () => {
  it("orders events: moved, merged, spawned, milestone, game.over", () => {
    const state = makeState(["10", "10", E, E, E, E, E, E, E, E, E, E, E, E, E, E], { score: "5" });
    const result = applyMove(state, "left", CLASSIC);
    const types = result.events.map((e) => e.type);
    expect(types).toEqual(["tile.moved", "tile.merged", "tile.spawned", "milestone.reached"]);
    expect(result.events[3]).toEqual({ type: "milestone.reached", exponent: "11", first2048: true });
    expect(result.state.celebrated2048).toBe(true);
    expect(result.state.score).toBe("2053");
    expect(result.state.status).toBe("active");

    // Already celebrated: reaching 12 is a milestone but not first2048.
    const next = makeState(["11", "11", E, E, E, E, E, E, E, E, E, E, E, E, E, E], { celebrated2048: true });
    expect(applyMove(next, "left", CLASSIC).events.filter((e) => e.type === "milestone.reached")).toEqual([
      { type: "milestone.reached", exponent: "12", first2048: false },
    ]);
    // Max does not rise: no milestone.
    const flat = makeState(["11", "11", "12", E, E, E, E, E, E, E, E, E, E, E, E, E], {
      celebrated2048: true,
    });
    expect(applyMove(flat, "left", CLASSIC).events.some((e) => e.type === "milestone.reached")).toBe(false);
  });

  it("emits game.over last when the post-spawn board is dead", () => {
    // Row 0 slides left leaving index 3 empty; any spawned 2 or 4 there leaves no merge.
    const base: Cell[] = [E, "3", "4", "5", "4", "5", "6", "7", "5", "6", "7", "8", "6", "7", "8", "9"];
    const result = applyMove(makeState(base), "left", CLASSIC);
    expect(result.state.status).toBe("completed");
    expect(result.events.map((e) => e.type)).toEqual([
      "tile.moved",
      "tile.moved",
      "tile.moved",
      "tile.spawned",
      "game.over",
    ]);
    expect(result.events[3]).toMatchObject({ type: "tile.spawned", at: 3 });
    expect(codeOf(() => applyMove(result.state, "up", CLASSIC))).toBe("GAME_NOT_ACTIVE");
  });

  it("completes at the move cap without a game.over event", () => {
    const ranked = RULESETS["ranked-v1"];
    const state = makeState(["1", E, E, E, E, E, E, E, E, E, E, E, E, E, E, E], {
      rulesetVersion: "ranked-v1",
      acceptedMoves: 499,
      revision: 499,
    });
    const result = applyMove(state, "right", ranked);
    expect(result.state.acceptedMoves).toBe(500);
    expect(result.state.status).toBe("completed");
    expect(result.events.some((e) => e.type === "game.over")).toBe(false);
    expect(codeOf(() => applyMove(result.state, "left", ranked))).toBe("GAME_NOT_ACTIVE");
  });

  it("no-op: same state, no draws, no events, no score", () => {
    const state = makeState(["1", "2", E, E, E, E, E, E, E, E, E, E, E, E, E, E]);
    const result = applyMove(state, "left", CLASSIC);
    expect(result).toEqual({ state, changed: false, scoreDelta: "0", events: [] });
    expect(result.state).toBe(state);
    const moved = applyMove(state, "right", CLASSIC);
    expect(moved.state.acceptedMoves).toBe(1);
    expect(moved.events.filter((e) => e.type === "tile.spawned")).toHaveLength(1);
  });

  it("rejects non-active games with GAME_NOT_ACTIVE", () => {
    const cells: Cell[] = ["1", E, E, E, E, E, E, E, E, E, E, E, E, E, E, E];
    for (const status of ["completed", "forfeited"] as const) {
      const state = makeState(cells.slice(), { status });
      expect(codeOf(() => applyMove(state, "right", CLASSIC))).toBe("GAME_NOT_ACTIVE");
      expect(codeOf(() => applyMove(state, "left", CLASSIC))).toBe("GAME_NOT_ACTIVE");
      expect(codeOf(() => forfeit(state))).toBe("GAME_NOT_ACTIVE");
    }
  });

  it("rejects mismatched rules, malformed states and directions with VALIDATION_ERROR", () => {
    const state = makeState(["1", E, E, E, E, E, E, E, E, E, E, E, E, E, E, E]);
    expect(codeOf(() => applyMove(state, "right", RULESETS["ranked-v1"]))).toBe("VALIDATION_ERROR");
    expect(
      codeOf(() => applyMove(state, "right", practiceRuleset({ size: 5, fourWeight: 1, undo: true }))),
    ).toBe("VALIDATION_ERROR");
    expect(codeOf(() => applyMove(state, "north" as Direction, CLASSIC))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => applyMove({ ...state, score: "01" }, "right", CLASSIC))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => applyMove({ ...state, score: 5 as unknown as string }, "right", CLASSIC))).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      codeOf(() =>
        applyMove({ ...state, rng: { algorithm: RNG_ALGORITHM, words: [0, 0, 0, 0] } }, "right", CLASSIC),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(codeOf(() => applyMove({ ...state, revision: -1 }, "right", CLASSIC))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => applyMove({ ...state, engineVersion: "2.0.0" }, "right", CLASSIC))).toBe(
      "REPLAY_VERSION_UNSUPPORTED",
    );
  });

  it("RESOURCE_LIMIT keeps the input state intact", () => {
    const state = makeState(["1000000", "1000000", E, E, E, E, E, E, E, E, E, E, E, E, E, E], {
      celebrated2048: true,
      score: "123",
    });
    const snapshot = JSON.stringify(state);
    expect(codeOf(() => applyMove(state, "left", CLASSIC))).toBe("RESOURCE_LIMIT");
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(applyMove(state, "down", CLASSIC).changed).toBe(true);
  });

  it("keeps exponents 54, 256, 4096 and scores above 2^53 exact", () => {
    const big = "9007199254740993"; // 2^53 + 1
    const state = makeState(["53", "53", E, E, "255", "255", E, E, "4095", "4095", E, E, "2", E, E, E], {
      score: big,
      celebrated2048: true,
    });
    const result = applyMove(state, "left", CLASSIC);
    expect([0, 4, 8].map((i) => result.state.board.cells[i])).toEqual(["54", "256", "4096"]);
    const expected = BigInt(big) + (1n << 54n) + (1n << 256n) + (1n << 4096n);
    expect(result.state.score).toBe(expected.toString());
    expect(result.scoreDelta).toBe((expected - BigInt(big)).toString());
  });
});

describe("forfeit and spawn", () => {
  it("forfeit changes only the status", () => {
    const state = newGame(CLASSIC, "forfeit");
    const frozen = deepFreeze(structuredClone(state));
    const result = forfeit(frozen);
    expect(result).toEqual({ ...state, status: "forfeited" });
    expect(Object.keys(result)).toEqual(Object.keys(state));
    expect(frozen.status).toBe("active");
  });

  it("spawn fills the only empty cell and consumes two draws", () => {
    const cells: Cell[] = new Array<Cell>(16).fill("3");
    cells[9] = null;
    const rng: RandomState = deepFreeze({ algorithm: RNG_ALGORITHM, words: [1, 2, 3, 4] });
    const result = spawn(deepFreeze({ size: 4, cells }), rng, 1);
    expect(result.at).toBe(9);
    expect(result.board.cells[9]).toBe(result.exponent);
    expect(rawDraws([1, 2, 3, 4], result.rng.words)).toBe(2);
    expect(cells[9]).toBeNull();
    expect(codeOf(() => spawn({ size: 4, cells: new Array<Cell>(16).fill("3") }, rng, 1))).toBe(
      "VALIDATION_ERROR",
    );
  });
});
