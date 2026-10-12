import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RNG_ALGORITHM, RULESETS, practiceRuleset } from "@g2048/contracts";
import type { Cell, Direction, GameState } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.js";
import { applyMove, newGame } from "./game.js";
import { canonicalJson, checksum, deserialize, serialize } from "./serialize.js";

type StateVec = { state: GameState; canonicalJson: string; checksum: string };
type Vectors = {
  newGame: { size: number; seed: string; state: GameState; canonicalJson: string; checksum: string }[];
  moveSequences: {
    seed: string;
    directions: Direction[];
    initial: StateVec;
    steps: { direction: Direction; checksum: string }[];
    final: StateVec;
  }[];
  highValue: {
    direction: Direction;
    before: StateVec;
    slide: { scoreDelta: string; scoreDeltaSha256: string; scoreDeltaDigits: number };
    applyMove: { after: StateVec };
  };
  transitions: { id: string; direction?: Direction; before?: StateVec; after?: StateVec }[];
};

const vectors = JSON.parse(
  readFileSync(new URL("../../contracts/vectors/engine-v1.json", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  ),
) as Vectors;

const CLASSIC = RULESETS["classic-v1"];

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

function expectCanonical(state: GameState, vec: { canonicalJson: string; checksum: string }): void {
  const json = canonicalJson(state);
  expect(json).toBe(vec.canonicalJson);
  expect(checksum(state)).toBe(vec.checksum);
  expect(createHash("sha256").update(json, "utf8").digest("hex")).toBe(vec.checksum);
  expect(serialize(state)).toBe(json);
  const round = deserialize(json);
  expect(round).toEqual(state);
  expect(canonicalJson(round)).toBe(json);
}

describe("canonical JSON and checksum vectors (ENG-04, ENG-10)", () => {
  for (const v of vectors.newGame) {
    it(`newGame size ${v.size} seed ${JSON.stringify(v.seed)}`, () => {
      const rules = v.size === 4 ? CLASSIC : practiceRuleset({ size: v.size, fourWeight: 1, undo: true });
      const state = newGame(rules, v.seed);
      expectCanonical(state, v);
      expectCanonical(deepFreeze(structuredClone(v.state)), v);
    });
  }

  for (const seq of vectors.moveSequences) {
    it(`moveSequence ${JSON.stringify(seq.seed)}: per-step checksums, final canonical state`, () => {
      let state = newGame(CLASSIC, seq.seed);
      expectCanonical(state, seq.initial);
      seq.steps.forEach((step, i) => {
        expect(step.direction).toBe(seq.directions[i]);
        state = applyMove(state, step.direction, CLASSIC).state;
        expect(checksum(state)).toBe(step.checksum);
        // reload after every move: same complete state (ENG-04)
        state = deserialize(serialize(state));
      });
      expectCanonical(state, seq.final);
    });
  }

  it("highValue before/after round-trip exactly (ENG-05)", () => {
    const v = vectors.highValue;
    expectCanonical(deepFreeze(structuredClone(v.before.state)), v.before);
    const after = applyMove(deserialize(v.before.canonicalJson), v.direction, CLASSIC).state;
    expectCanonical(after, v.applyMove.after);
    expect(after.score).toHaveLength(v.slide.scoreDeltaDigits);
    expect(createHash("sha256").update(after.score).digest("hex")).toBe(v.slide.scoreDeltaSha256);
  });

  for (const t of vectors.transitions) {
    if (t.before === undefined || t.after === undefined || t.direction === undefined) continue;
    it(`transition ${t.id}`, () => {
      const before = deserialize(t.before!.canonicalJson);
      expectCanonical(before, t.before!);
      expectCanonical(applyMove(before, t.direction!, CLASSIC).state, t.after!);
    });
  }
});

describe("high values survive serialize/deserialize (ENG-05)", () => {
  it("exponents 54, 256, 4096 and score > 2^53", () => {
    const cells: Cell[] = new Array<Cell>(16).fill(null);
    cells[0] = "54";
    cells[5] = "256";
    cells[10] = "4096";
    cells[15] = "1000000";
    const score = ((1n << 4096n) + 12345n).toString();
    const state: GameState = deepFreeze({
      schemaVersion: 1,
      engineVersion: "1.0.0",
      rulesetVersion: "classic-v1",
      board: { size: 4, cells },
      score,
      acceptedMoves: 9007199254740991,
      revision: 9007199254740991,
      rng: { algorithm: RNG_ALGORITHM, words: [4294967295, 0, 1, 2] },
      status: "completed",
      celebrated2048: true,
    });
    const json = serialize(state);
    expect(json).toContain(`"score":"${score}"`);
    expect(json).toContain('"cells":["54",null');
    const round = deserialize(json);
    expect(round).toEqual(state);
    expect(round.board.cells[10]).toBe("4096");
    expect(round.score).toBe(score);
    expect(checksum(round)).toBe(checksum(state));
  });
});

describe("deserialize strict validation (ENG-09)", () => {
  const base = newGame(CLASSIC, "validation");
  const json = canonicalJson(base);
  const mutate = (fn: (s: Record<string, unknown>) => void): string => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    fn(obj);
    return JSON.stringify(obj);
  };
  const board = (s: Record<string, unknown>) => s.board as Record<string, unknown>;
  const rng = (s: Record<string, unknown>) => s.rng as Record<string, unknown>;

  const validationCases: [string, string][] = [
    ["not JSON", "{"],
    ["array", "[]"],
    ["null", "null"],
    ["number", "42"],
    ["extra key", mutate((s) => (s.extra = 1))],
    ["missing key", mutate((s) => delete s.celebrated2048)],
    ["__proto__ key", json.replace('{"schemaVersion"', '{"__proto__":{},"schemaVersion"')],
    ["schemaVersion string", mutate((s) => (s.schemaVersion = "1"))],
    ["board size 2", mutate((s) => (board(s).size = 2))],
    ["board size 9", mutate((s) => (board(s).size = 9))],
    ["board size float", mutate((s) => (board(s).size = 4.5))],
    ["cells too short", mutate((s) => (board(s).cells = new Array(15).fill(null)))],
    ["cells too long", mutate((s) => (board(s).cells = new Array(17).fill(null)))],
    ["cells not array", mutate((s) => (board(s).cells = "x"))],
    ["exponent number", mutate((s) => ((board(s).cells as unknown[])[0] = 1))],
    ["exponent zero", mutate((s) => ((board(s).cells as unknown[])[0] = "0"))],
    ["exponent leading zero", mutate((s) => ((board(s).cells as unknown[])[0] = "01"))],
    ["exponent negative", mutate((s) => ((board(s).cells as unknown[])[0] = "-1"))],
    ["exponent above maxExponent", mutate((s) => ((board(s).cells as unknown[])[0] = "1000001"))],
    ["board extra key", mutate((s) => (board(s).extra = true))],
    ["score number", mutate((s) => (s.score = 0))],
    ["score leading zero", mutate((s) => (s.score = "007"))],
    ["score negative", mutate((s) => (s.score = "-5"))],
    ["score float", mutate((s) => (s.score = "1.5"))],
    ["score exponent notation", mutate((s) => (s.score = "1e30"))],
    ["score too long", mutate((s) => (s.score = "9".repeat(400_000)))],
    ["acceptedMoves negative", mutate((s) => (s.acceptedMoves = -1))],
    ["acceptedMoves float", mutate((s) => (s.acceptedMoves = 1.5))],
    ["revision unsafe", mutate((s) => (s.revision = 2 ** 53))],
    ["revision string", mutate((s) => (s.revision = "1"))],
    ["rng zero state", mutate((s) => (rng(s).words = [0, 0, 0, 0]))],
    ["rng word too large", mutate((s) => (rng(s).words = [2 ** 32, 1, 1, 1]))],
    ["rng word negative", mutate((s) => (rng(s).words = [-1, 1, 1, 1]))],
    ["rng word float", mutate((s) => (rng(s).words = [1.5, 1, 1, 1]))],
    ["rng word string", mutate((s) => (rng(s).words = ["1", 1, 1, 1]))],
    ["rng three words", mutate((s) => (rng(s).words = [1, 1, 1]))],
    ["rng extra key", mutate((s) => (rng(s).extra = 1))],
    ["rng algorithm missing", mutate((s) => delete rng(s).algorithm)],
    ["status unknown", mutate((s) => (s.status = "paused"))],
    ["celebrated2048 string", mutate((s) => (s.celebrated2048 = "false"))],
    ["rulesetVersion bad", mutate((s) => (s.rulesetVersion = "Classic V1"))],
    ["engineVersion number", mutate((s) => (s.engineVersion = 1))],
  ];
  for (const [name, input] of validationCases) {
    it(`VALIDATION_ERROR: ${name}`, () => expect(codeOf(() => deserialize(input))).toBe("VALIDATION_ERROR"));
  }

  const versionCases: [string, string][] = [
    ["schemaVersion 2", mutate((s) => (s.schemaVersion = 2))],
    ["schemaVersion 2 with new keys", mutate((s) => ((s.schemaVersion = 2), (s.newField = true)))],
    ["engineVersion 2.0.0", mutate((s) => (s.engineVersion = "2.0.0"))],
    ["rng algorithm pcg", mutate((s) => (rng(s).algorithm = "pcg32-v1"))],
  ];
  for (const [name, input] of versionCases) {
    it(`REPLAY_VERSION_UNSUPPORTED: ${name}`, () =>
      expect(codeOf(() => deserialize(input))).toBe("REPLAY_VERSION_UNSUPPORTED"));
  }

  it("rejects non-string and oversized input", () => {
    expect(codeOf(() => deserialize(42 as unknown as string))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => deserialize(" ".repeat(1_000_001)))).toBe("VALIDATION_ERROR");
  });

  it("accepts whitespace and any key order, returning canonical key order", () => {
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(json) as Record<string, unknown>).reverse()),
      null,
      2,
    );
    const state = deserialize(reordered);
    expect(canonicalJson(state)).toBe(json);
    expect(Object.keys(state)).toEqual(Object.keys(base));
  });

  it("canonicalJson rejects malformed in-memory states", () => {
    expect(codeOf(() => canonicalJson({ ...base, score: "01" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => checksum({ ...base, schemaVersion: 2 as 1 }))).toBe("REPLAY_VERSION_UNSUPPORTED");
  });
});
