import { readFileSync } from "node:fs";
import { LIMITS, RULESETS } from "@g2048/contracts";
import type { Direction, GameState, ReplayFile } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.js";
import { newGame } from "./game.js";
import { replay, verifyReplay } from "./replay.js";
import { checksum } from "./serialize.js";

type Vectors = {
  moveSequences: {
    seed: string;
    directions: Direction[];
    initial: { state: GameState; checksum: string };
    steps: { changed: boolean; direction: Direction; revision: number; checksum: string }[];
    final: { state: GameState; checksum: string };
  }[];
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

function replayFileFor(seq: Vectors["moveSequences"][number]): ReplayFile {
  return {
    replaySchemaVersion: 1,
    engineVersion: "1.0.0",
    rulesetVersion: "classic-v1",
    seed: seq.seed,
    initialState: structuredClone(seq.initial.state),
    initialChecksum: seq.initial.checksum,
    moves: seq.steps
      .filter((s) => s.changed)
      .map((s) => ({ revision: s.revision, direction: s.direction, checksum: s.checksum })),
    finalChecksum: seq.final.checksum,
    meta: { mode: "classic", displayName: null, createdAt: "2026-10-12T00:00:00.000Z", source: "local" },
  };
}

describe("replay()", () => {
  for (const seq of vectors.moveSequences) {
    it(`reproduces moveSequence ${JSON.stringify(seq.seed)} checksums (no-ops repeat the checksum)`, () => {
      const initial = deepFreeze(structuredClone(seq.initial.state));
      const directions = deepFreeze([...seq.directions]);
      const result = replay(initial, directions, CLASSIC);
      expect(result.checksums).toEqual(seq.steps.map((s) => s.checksum));
      expect(result.final).toEqual(seq.final.state);
      expect(checksum(result.final)).toBe(seq.final.checksum);
    });
  }

  it("throws GAME_NOT_ACTIVE for a move after completion and RESOURCE_LIMIT for too many moves", () => {
    const initial = newGame(CLASSIC, "x");
    const done = { ...initial, status: "completed" as const };
    expect(codeOf(() => replay(done, ["left"], CLASSIC))).toBe("GAME_NOT_ACTIVE");
    const tooMany = new Array<Direction>(LIMITS.replayMaxMoves + 1).fill("left");
    expect(codeOf(() => replay(initial, tooMany, CLASSIC))).toBe("RESOURCE_LIMIT");
    expect(codeOf(() => replay(initial, "left" as unknown as Direction[], CLASSIC))).toBe("VALIDATION_ERROR");
  });
});

describe("verifyReplay()", () => {
  const seq = vectors.moveSequences[0]!;

  it("accepts a faithful replay for each move sequence", () => {
    for (const s of vectors.moveSequences) {
      const result = verifyReplay(deepFreeze(replayFileFor(s)), CLASSIC);
      expect(result).toEqual({ ok: true, final: s.final.state });
    }
  });

  it("accepts a zero-move replay", () => {
    const initial = newGame(CLASSIC, "empty");
    const file: ReplayFile = {
      ...replayFileFor(seq),
      seed: "empty",
      initialState: initial,
      initialChecksum: checksum(initial),
      moves: [],
      finalChecksum: checksum(initial),
    };
    expect(verifyReplay(file, CLASSIC)).toEqual({ ok: true, final: initial });
  });

  type Case = [string, (f: ReplayFile) => void, string, number | null];
  const cases: Case[] = [
    [
      "unsupported replaySchemaVersion",
      (f) => ((f as { replaySchemaVersion: number }).replaySchemaVersion = 2),
      "REPLAY_VERSION_UNSUPPORTED",
      null,
    ],
    ["unsupported engineVersion", (f) => (f.engineVersion = "0.9.0"), "REPLAY_VERSION_UNSUPPORTED", null],
    [
      "initial state engineVersion",
      (f) => ((f.initialState as { engineVersion: string }).engineVersion = "9"),
      "REPLAY_VERSION_UNSUPPORTED",
      null,
    ],
    ["ruleset mismatch", (f) => (f.rulesetVersion = "ranked-v1"), "VALIDATION_ERROR", null],
    ["wrong seed", (f) => (f.seed = "not-the-seed"), "VALIDATION_ERROR", null],
    [
      "forged initial score",
      (f) => ((f.initialState as { score: string }).score = "1000"),
      "VALIDATION_ERROR",
      null,
    ],
    ["initialChecksum mismatch", (f) => (f.initialChecksum = "0".repeat(64)), "VALIDATION_ERROR", null],
    ["initialChecksum not hex", (f) => (f.initialChecksum = "XYZ"), "VALIDATION_ERROR", null],
    ["forged final checksum", (f) => (f.finalChecksum = "f".repeat(64)), "VALIDATION_ERROR", null],
    ["moves not array", (f) => ((f as { moves: unknown }).moves = {}), "VALIDATION_ERROR", null],
    ["meta missing", (f) => ((f as { meta: unknown }).meta = null), "VALIDATION_ERROR", null],
    ["forged move checksum", (f) => (f.moves[3]!.checksum = "a".repeat(64)), "VALIDATION_ERROR", 3],
    ["wrong move revision", (f) => (f.moves[5]!.revision = 99), "VALIDATION_ERROR", 5],
    [
      "swapped direction",
      (f) => (f.moves[0]!.direction = f.moves[0]!.direction === "up" ? "down" : "up"),
      "VALIDATION_ERROR",
      0,
    ],
    [
      "invalid direction",
      (f) => ((f.moves[2] as { direction: string }).direction = "diag"),
      "VALIDATION_ERROR",
      2,
    ],
    ["move not object", (f) => ((f.moves as unknown[])[4] = "left"), "VALIDATION_ERROR", 4],
    ["dropped move", (f) => f.moves.splice(7, 1), "VALIDATION_ERROR", 7],
  ];
  for (const [name, mutate, code, atMove] of cases) {
    it(`rejects ${name}`, () => {
      const file = replayFileFor(seq);
      mutate(file);
      const result = verifyReplay(file, CLASSIC);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.atMove).toBe(atMove);
        expect(result.message).toBeTypeOf("string");
      }
    });
  }

  it("rejects a recorded no-op move", () => {
    // Steps 0..4 change the board and step 5 is a recorded no-op in the vector.
    expect(seq.steps.slice(0, 5).every((s) => s.changed)).toBe(true);
    const noop = seq.steps[5]!;
    expect(noop.changed).toBe(false);
    const file = replayFileFor(seq);
    file.moves.splice(5, 0, { revision: noop.revision, direction: noop.direction, checksum: noop.checksum });
    expect(verifyReplay(file, CLASSIC)).toMatchObject({ ok: false, code: "VALIDATION_ERROR", atMove: 5 });
  });

  it("rejects oversized replays with RESOURCE_LIMIT and never throws on garbage", () => {
    const file = replayFileFor(seq);
    file.moves = new Array(LIMITS.replayMaxMoves + 1).fill(file.moves[0]);
    expect(verifyReplay(file, CLASSIC)).toMatchObject({ ok: false, code: "RESOURCE_LIMIT", atMove: null });
    for (const garbage of [null, 42, "replay", [], {}]) {
      expect(verifyReplay(garbage as unknown as ReplayFile, CLASSIC)).toMatchObject({
        ok: false,
        atMove: null,
      });
    }
    expect(verifyReplay(replayFileFor(seq), { ...CLASSIC, size: 99 })).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
  });
});
