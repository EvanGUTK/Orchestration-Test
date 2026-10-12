import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLASSIC_RULES, DomainError, RANKED_RULES, customRules, resolveRules } from "@2048/contracts";
import type { Cell, Direction, GameState, Ruleset } from "@2048/contracts";
import {
  applyMove, createRng, deriveSeedWords, deserialize, isGameOver, legalMoves, newGame, replay,
  serialize, sha256Hex, slide, stateChecksum, validateState,
} from "../src/index.ts";
import { board16, deepFreeze, makeState } from "./helpers.ts";

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const slideFixtures = readJson("../../../tests/fixtures/slide-v1.json");
const prngGolden = readJson("../../contracts/golden/prng-v1.json");
const gamesGolden = readJson("../../contracts/golden/games-v1.json");

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return undefined;
}

describe("sha256", () => {
  it("matches FIPS 180-4 / node:crypto vectors", async () => {
    const { createHash } = await import("node:crypto");
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "héllo wörld ✓ 😀"]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("PRNG golden vectors", () => {
  it("raw xoshiro128** outputs and final state", () => {
    const rng = createRng(prngGolden.raw.initialWords);
    const outs = prngGolden.raw.outputs.map(() => rng.next());
    expect(outs).toEqual(prngGolden.raw.outputs);
    expect(rng.state()).toEqual({ algorithm: "xoshiro128ss-v1", words: prngGolden.raw.finalWords });
  });
  it("seed derivation, stream, and bot namespace", () => {
    for (const s of prngGolden.seeds) {
      expect(deriveSeedWords(s.seed)).toEqual(s.words);
      expect(deriveSeedWords(s.seed, "2048-infinite/v1/bot")).toEqual(s.botWords);
      const rng = createRng(s.words);
      expect(s.outputs.map(() => rng.next())).toEqual(s.outputs);
      expect(rng.state().words).toEqual(s.finalWords);
    }
  });
  it("unbiased bounded draws", () => {
    for (const b of prngGolden.bounded) {
      const rng = createRng(deriveSeedWords(b.seed));
      expect(b.values.map(() => rng.below(b.n))).toEqual(b.values);
      expect(rng.state().words).toEqual(b.finalWords);
    }
  });
  it("rejects zero/invalid state and bad bounds", () => {
    expect(errorCode(() => createRng([0, 0, 0, 0]))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => createRng([1, 2, 3]))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => createRng([1, 2, 3, 2 ** 32]))).toBe("VALIDATION_ERROR");
    const rng = createRng([1, 2, 3, 4]);
    expect(errorCode(() => rng.below(0))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => rng.below(1.5))).toBe("VALIDATION_ERROR");
    expect(rng.below(1)).toBe(0);
  });
  it("substitutes [1,0,0,0] only when all four derived words are zero (helper stays within range)", () => {
    for (const s of ["", "x", "y"]) {
      const w = deriveSeedWords(s);
      expect(w.every((x) => x >= 0 && x <= 0xffffffff)).toBe(true);
    }
  });
});

describe("slide fixtures (tests/fixtures/slide-v1.json)", () => {
  for (const v of slideFixtures.vectors) {
    it(v.id, () => {
      const board = deepFreeze({ size: v.size, cells: v.before as Cell[] });
      const r = slide(board, v.direction);
      expect(r.board.cells).toEqual(v.after);
      expect(r.scoreDelta).toBe(v.scoreDelta);
      expect(r.changed).toBe(v.changed);
    });
  }
});

describe("slide semantics", () => {
  it("never double merges", () => {
    const r = slide({ size: 4, cells: board16(["1", "1", "2"]) }, "left");
    expect(r.board.cells.slice(0, 4)).toEqual(["2", "2", null, null]);
    expect(r.events.filter((e) => e.type === "merge")).toHaveLength(1);
  });
  it("[1,1,1,1] merges leading pairs only", () => {
    const r = slide({ size: 4, cells: board16(["1", "1", "1", "1"]) }, "right");
    expect(r.board.cells.slice(0, 4)).toEqual([null, null, "2", "2"]);
    expect(r.scoreDelta).toBe("8");
  });
  it("orders events: moves then merges, destination row-major, leading source first", () => {
    const r = slide({ size: 4, cells: board16([null, "1", null, "1", "3", null, null, "3"]) }, "left");
    expect(r.events).toEqual([
      { type: "move", from: 1, to: 0, exponent: "1" },
      { type: "move", from: 3, to: 0, exponent: "1" },
      { type: "move", from: 7, to: 4, exponent: "3" },
      { type: "merge", sources: [1, 3], to: 0, exponent: "2", value: "4" },
      { type: "merge", sources: [4, 7], to: 4, exponent: "4", value: "16" },
    ]);
    expect(r.scoreDelta).toBe("20");
  });
  it("no-op returns the same board and no events", () => {
    const board = deepFreeze({ size: 4, cells: board16(["1", "2"]) });
    const r = slide(board, "left");
    expect(r.changed).toBe(false);
    expect(r.board).toBe(board);
    expect(r.events).toEqual([]);
    expect(r.scoreDelta).toBe("0");
  });
  it("rejects malformed boards and directions", () => {
    expect(errorCode(() => slide({ size: 4, cells: ["1"] }, "left"))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => slide({ size: 4, cells: board16(["01"]) }, "left"))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => slide({ size: 4, cells: board16(["0"]) }, "left"))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => slide({ size: 4, cells: board16([1 as unknown as string]) }, "left"))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => slide({ size: 4, cells: board16(["1"]) }, "north" as Direction))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => slide({ size: 4, cells: board16(["12345678"]) }, "left"))).toBe("RESOURCE_LIMIT");
  });
  it("works for 3x3 and 8x8 boards", () => {
    const b3 = slide({ size: 3, cells: ["1", "1", null, null, null, null, null, null, null] }, "left");
    expect(b3.board.cells.slice(0, 3)).toEqual(["2", null, null]);
    const cells = new Array<Cell>(64).fill(null);
    cells[63] = "5";
    cells[56] = "5";
    const b8 = slide({ size: 8, cells }, "left");
    expect(b8.board.cells[56]).toBe("6");
    expect(b8.scoreDelta).toBe("64");
  });
});

describe("legalMoves / isGameOver", () => {
  it("lists moves in up,right,down,left order", () => {
    expect(legalMoves({ size: 4, cells: board16(["1"]) })).toEqual(["right", "down"]);
    expect(legalMoves({ size: 4, cells: board16([null, null, null, "1"]) })).toEqual(["down", "left"]);
    expect(legalMoves({ size: 4, cells: board16([]) })).toEqual([]);
  });
  it("agrees with slide().changed for random boards", () => {
    const rng = createRng([7, 11, 13, 17]);
    for (let n = 0; n < 500; n++) {
      const cells: Cell[] = Array.from({ length: 16 }, () => {
        const v = rng.below(5);
        return v === 0 ? null : String(v);
      });
      const board = { size: 4, cells };
      const expected = (["up", "right", "down", "left"] as Direction[]).filter((d) => slide(board, d).changed);
      expect(legalMoves(board)).toEqual(expected);
      expect(isGameOver(board)).toBe(expected.length === 0);
    }
  });
  it("detects a dead board", () => {
    const dead: Cell[] = ["1", "2", "1", "2", "2", "1", "2", "1", "1", "2", "1", "2", "2", "1", "2", "1"];
    expect(isGameOver({ size: 4, cells: dead })).toBe(true);
    expect(legalMoves({ size: 4, cells: dead })).toEqual([]);
    dead[15] = "2";
    expect(isGameOver({ size: 4, cells: dead })).toBe(false);
  });
});

describe("newGame", () => {
  it("is deterministic and matches golden initial states", () => {
    for (const g of gamesGolden.games) {
      const rules = resolveRules(g.rulesetVersion) as Ruleset;
      const s = newGame(rules, g.seed);
      expect(s.board.cells).toEqual(g.initial.cells);
      expect(s.rng.words).toEqual(g.initial.rngWords);
      expect(stateChecksum(s)).toBe(g.initial.checksum);
      expect(s.status).toBe("active");
      expect(newGame(rules, g.seed)).toEqual(s);
    }
  });
  it("rejects invalid rules or seed", () => {
    expect(errorCode(() => newGame({ ...CLASSIC_RULES, boardSize: 2 }, "s"))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => newGame({ ...CLASSIC_RULES, spawnFourTenths: 11 }, "s"))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => newGame(CLASSIC_RULES, 5 as unknown as string))).toBe("VALIDATION_ERROR");
  });
});

describe("golden game replays", () => {
  for (const g of gamesGolden.games) {
    it(`${g.rulesetVersion} / ${g.seed}: every step matches`, () => {
      const rules = resolveRules(g.rulesetVersion) as Ruleset;
      expect(rules.boardSize).toBe(g.boardSize);
      expect(rules.spawnFourTenths).toBe(g.spawnFourTenths);
      expect(rules.moveCap).toBe(g.moveCap);
      let state = newGame(rules, g.seed);
      for (const [i, step] of g.steps.entries()) {
        const r = applyMove(deepFreeze(state), step.direction, rules);
        const where = `step ${i}`;
        expect({ where, changed: r.changed }).toEqual({ where, changed: step.changed });
        expect({ where, d: r.scoreDelta }).toEqual({ where, d: step.scoreDelta });
        expect({ where, v: r.state.revision }).toEqual({ where, v: step.revision });
        expect(r.state.acceptedMoves).toBe(step.acceptedMoves);
        expect(r.state.score).toBe(step.score);
        expect(r.state.status).toBe(step.status);
        expect(r.state.rng.words).toEqual(step.rngWords);
        expect({ where, c: stateChecksum(r.state) }).toEqual({ where, c: step.checksum });
        state = r.state;
      }
      expect(stateChecksum(state)).toBe(g.finalChecksum);
      // replay() must reproduce the same checksum chain
      const initial = newGame(rules, g.seed);
      const rep = replay(deepFreeze(initial), g.steps.map((s: { direction: Direction }) => s.direction), rules);
      expect(rep.steps.map((s) => s.checksum)).toEqual(g.steps.map((s: { checksum: string }) => s.checksum));
      expect(rep.steps.map((s) => s.changed)).toEqual(g.steps.map((s: { changed: boolean }) => s.changed));
      expect(stateChecksum(rep.state)).toBe(g.finalChecksum);
    });
  }
});

describe("applyMove behaviors", () => {
  it("no-op returns the identical state object, zero draws, no events", () => {
    const s = deepFreeze(makeState(board16(["1", "2"])));
    const r = applyMove(s, "left", CLASSIC_RULES);
    expect(r.changed).toBe(false);
    expect(r.state).toBe(s);
    expect(r.scoreDelta).toBe("0");
    expect(r.events).toEqual([]);
  });
  it("does not mutate deep-frozen inputs and returns fresh objects", () => {
    const s = deepFreeze(newGame(CLASSIC_RULES, "immut"));
    const rules = deepFreeze({ ...CLASSIC_RULES });
    const before = serialize(s);
    for (const d of ["up", "right", "down", "left"] as Direction[]) {
      const r = applyMove(s, d, rules);
      if (r.changed) {
        expect(r.state).not.toBe(s);
        expect(r.state.board.cells).not.toBe(s.board.cells);
        expect(r.state.rng.words).not.toBe(s.rng.words);
      }
    }
    legalMoves(s.board);
    isGameOver(s.board);
    stateChecksum(s);
    serialize(s);
    replay(s, ["left", "up"], rules);
    expect(serialize(s)).toBe(before);
  });
  it("emits events in contract order with exactly one spawn", () => {
    const s = makeState(board16(["1", "1", null, null, "3", null, null, null]));
    const r = applyMove(s, "left", CLASSIC_RULES);
    const types = r.events.map((e) => e.type);
    expect(types).toEqual(["move", "merge", "spawn"]);
    expect(r.state.revision).toBe(1);
    expect(r.state.acceptedMoves).toBe(1);
    expect(r.state.score).toBe("4");
    const spawn = r.events[2] as { type: "spawn"; index: number; exponent: string };
    expect(r.state.board.cells[spawn.index]).toBe(spawn.exponent);
    expect(r.state.board.cells.filter((c) => c !== null)).toHaveLength(3);
  });
  it("2048 milestone and celebrated flag fire once", () => {
    const s = makeState(board16(["10", "10", null, null, "9", "9", null, null]));
    const r1 = applyMove(s, "left", CLASSIC_RULES);
    expect(r1.events.filter((e) => e.type === "milestone")).toEqual([{ type: "milestone", exponent: "11" }]);
    expect(r1.state.celebrated2048).toBe(true);
    expect(r1.state.score).toBe(String(2 ** 11 + 2 ** 10));
    // merge 11+11 -> 12: new milestone 12 only; flag stays true; no second 2048 milestone
    const s2 = makeState(board16(["11", "11"]), { celebrated2048: true });
    const r2 = applyMove(s2, "left", CLASSIC_RULES);
    expect(r2.events.filter((e) => e.type === "milestone")).toEqual([{ type: "milestone", exponent: "12" }]);
    expect(r2.state.celebrated2048).toBe(true);
    // no milestone when the max does not change
    const s3 = makeState(board16(["11", null, "3", "3"]), { celebrated2048: true });
    expect(applyMove(s3, "left", CLASSIC_RULES).events.some((e) => e.type === "milestone")).toBe(false);
  });
  it("handles exponent 4096 and scores beyond 2^53 exactly", () => {
    const s = makeState(board16(["4095", "4095"]), { score: "9007199254740993" });
    const r = applyMove(s, "left", CLASSIC_RULES);
    const expectedDelta = (1n << 4096n).toString();
    expect(r.scoreDelta).toBe(expectedDelta);
    expect(r.state.score).toBe((9007199254740993n + (1n << 4096n)).toString());
    expect(r.state.board.cells[0]).toBe("4096");
    expect(r.events).toContainEqual({ type: "merge", sources: [0, 1], to: 0, exponent: "4096", value: expectedDelta });
    expect(r.events).toContainEqual({ type: "milestone", exponent: "4096" });
    expect(r.events.filter((e) => e.type === "milestone")).toHaveLength(1);
    expect(deserialize(serialize(r.state))).toEqual(r.state);
  });
  it("scores above 2^53 from small exponents are exact", () => {
    const s = makeState(board16(["53", "53"]), { score: "18014398509481983" });
    const r = applyMove(s, "left", CLASSIC_RULES);
    expect(r.state.score).toBe("36028797018963967");
  });
  it("detects a dead board after the spawn and completes", () => {
    const cells: Cell[] = [null, "4", "3", "4", "3", "4", "3", "4", "4", "3", "4", "3", "3", "4", "3", "4"];
    const r = applyMove(makeState(cells), "left", CLASSIC_RULES);
    expect(r.changed).toBe(true);
    expect(r.state.status).toBe("completed");
    expect(r.events[r.events.length - 1]).toEqual({ type: "game-over" });
    expect(isGameOver(r.state.board)).toBe(true);
    expect(errorCode(() => applyMove(r.state, "left", CLASSIC_RULES))).toBe("FORBIDDEN");
  });
  it("completes at the move cap and refuses further moves", () => {
    const rules = customRules({ boardSize: 4, moveCap: 2 });
    let s = newGame(rules, "cap");
    let capEvents = 0;
    let moves = 0;
    while (s.status === "active") {
      const d = legalMoves(s.board)[0] as Direction;
      const r = applyMove(s, d, rules);
      capEvents += r.events.filter((e) => e.type === "move-cap").length;
      s = r.state;
      moves++;
    }
    expect(moves).toBe(2);
    expect(capEvents).toBe(1);
    expect(s.acceptedMoves).toBe(2);
    expect(s.status).toBe("completed");
    expect(errorCode(() => applyMove(s, "left", rules))).toBe("FORBIDDEN");
    // forfeited is also non-active
    expect(errorCode(() => applyMove(makeState(board16(["1"]), { status: "forfeited" }), "right", CLASSIC_RULES))).toBe("FORBIDDEN");
  });
  it("rejects mismatched rules, bad directions, and malformed state", () => {
    const s = newGame(CLASSIC_RULES, "x");
    expect(errorCode(() => applyMove(s, "left", RANKED_RULES))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => applyMove(s, "diag" as Direction, CLASSIC_RULES))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => applyMove({ ...s, score: "01" }, "left", CLASSIC_RULES))).toBe("VALIDATION_ERROR");
  });
  it("RESOURCE_LIMIT leaves the game untouched when a merge exceeds the supported exponent", () => {
    const s = deepFreeze(makeState(board16(["1000000", "1000000", "1"])));
    expect(errorCode(() => applyMove(s, "left", CLASSIC_RULES))).toBe("RESOURCE_LIMIT");
    expect(errorCode(() => slide(s.board, "left"))).toBe("RESOURCE_LIMIT");
    // moves that do not merge the huge tiles still work
    expect(applyMove(s, "down", CLASSIC_RULES).changed).toBe(true);
  });
});

describe("serialization and validation", () => {
  it("round-trips and checksum equals sha256 of canonical json", () => {
    const s = newGame(CLASSIC_RULES, "rt");
    const json = serialize(s);
    expect(deserialize(json)).toEqual(s);
    expect(stateChecksum(s)).toBe(sha256Hex(json));
    expect(json).not.toMatch(/\s/);
  });
  it("rejects malformed state", () => {
    const good = newGame(CLASSIC_RULES, "bad");
    const mutate = (f: (s: Record<string, unknown>) => void) => {
      const c = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      f(c);
      return c;
    };
    const cases: [string, unknown][] = [
      ["null", null],
      ["array", []],
      ["missing key", mutate((s) => delete s.score)],
      ["extra key", mutate((s) => (s.extra = 1))],
      ["bad schema", mutate((s) => (s.schemaVersion = 2))],
      ["bad engine", mutate((s) => (s.engineVersion = "engine-0"))],
      ["number score", mutate((s) => (s.score = 5))],
      ["leading zero score", mutate((s) => (s.score = "007"))],
      ["negative score", mutate((s) => (s.score = "-1"))],
      ["float score", mutate((s) => (s.score = "1.5"))],
      ["unsafe counter", mutate((s) => (s.acceptedMoves = 2 ** 53))],
      ["negative revision", mutate((s) => (s.revision = -1))],
      ["fractional revision", mutate((s) => (s.revision = 1.5))],
      ["bad status", mutate((s) => (s.status = "paused"))],
      ["bad flag", mutate((s) => (s.celebrated2048 = "no"))],
      ["zero rng", mutate((s) => ((s.rng as { words: number[] }).words = [0, 0, 0, 0]))],
      ["short rng", mutate((s) => ((s.rng as { words: number[] }).words = [1, 2, 3]))],
      ["float rng", mutate((s) => ((s.rng as { words: number[] }).words = [1, 2, 3, 0.5]))],
      ["big rng", mutate((s) => ((s.rng as { words: number[] }).words = [1, 2, 3, 2 ** 32]))],
      ["bad algo", mutate((s) => ((s.rng as { algorithm: string }).algorithm = "mt19937"))],
      ["bad size", mutate((s) => ((s.board as { size: number }).size = 9))],
      ["cell count", mutate((s) => ((s.board as { cells: unknown[] }).cells = ["1"]))],
      ["zero cell", mutate((s) => ((s.board as { cells: unknown[] }).cells[0] = "0"))],
      ["numeric cell", mutate((s) => ((s.board as { cells: unknown[] }).cells[0] = 3))],
      ["leading zero cell", mutate((s) => ((s.board as { cells: unknown[] }).cells[0] = "02"))],
      ["float cell", mutate((s) => ((s.board as { cells: unknown[] }).cells[0] = "2.5"))],
    ];
    for (const [name, value] of cases) {
      expect({ name, code: errorCode(() => validateState(value)) }).toEqual({ name, code: "VALIDATION_ERROR" });
      expect({ name, code: errorCode(() => stateChecksum(value as GameState)) }).toEqual({ name, code: "VALIDATION_ERROR" });
    }
    expect(errorCode(() => deserialize("{not json"))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => deserialize(5 as unknown as string))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => serialize({ ...good, score: "x" }))).toBe("VALIDATION_ERROR");
  });
  it("applies resource guards on oversized exponents/scores/input", () => {
    const good = newGame(CLASSIC_RULES, "rl");
    const c = JSON.parse(JSON.stringify(good)) as { board: { cells: unknown[] }; score: string };
    c.board.cells[0] = "12345678"; // 8 digits
    expect(errorCode(() => validateState(c))).toBe("RESOURCE_LIMIT");
    expect(errorCode(() => deserialize(JSON.stringify(c)))).toBe("RESOURCE_LIMIT");
    c.board.cells[0] = "9999999"; // 7 digits is accepted
    expect(validateState(c).board.cells[0]).toBe("9999999");
    c.board.cells[0] = null;
    c.score = "9".repeat(4_000_001);
    expect(errorCode(() => validateState(c))).toBe("RESOURCE_LIMIT");
    expect(errorCode(() => deserialize(" ".repeat(16_000_001)))).toBe("RESOURCE_LIMIT");
  });
  it("validateState returns a deep copy", () => {
    const s = deepFreeze(newGame(CLASSIC_RULES, "copy"));
    const v = validateState(s);
    expect(v).toEqual(s);
    expect(v.board.cells).not.toBe(s.board.cells);
    expect(v.rng.words).not.toBe(s.rng.words);
  });
});

describe("replay", () => {
  it("is equivalent to sequential applyMove and rejects moves after the game ends", () => {
    const rules = customRules({ boardSize: 4, moveCap: 3 });
    const init = newGame(rules, "replay");
    const dirs: Direction[] = [];
    let s = init;
    while (s.status === "active") {
      const d = legalMoves(s.board)[0] as Direction;
      dirs.push(d);
      s = applyMove(s, d, rules).state;
    }
    const rep = replay(init, dirs, rules);
    expect(rep.state).toEqual(s);
    expect(rep.steps).toHaveLength(dirs.length);
    expect(errorCode(() => replay(init, [...dirs, "left"], rules))).toBe("FORBIDDEN");
    expect(errorCode(() => replay(init, ["sideways" as Direction], rules))).toBe("VALIDATION_ERROR");
    expect(errorCode(() => replay(init, "left" as unknown as Direction[], rules))).toBe("VALIDATION_ERROR");
  });
  it("records unchanged moves with an unchanged checksum", () => {
    const init = makeState(board16(["1", "2"]));
    const rep = replay(init, ["left", "left"], CLASSIC_RULES);
    expect(rep.steps.map((s) => s.changed)).toEqual([false, false]);
    expect(rep.steps[0]?.checksum).toBe(stateChecksum(init));
  });
});
