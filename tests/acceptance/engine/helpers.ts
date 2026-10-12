import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { ENGINE_VERSION, RNG_ALGORITHM, RULESETS, SCHEMA_VERSION, practiceRuleset } from "@g2048/contracts";
import type {
  Board,
  Cell,
  Direction,
  EngineErrorCode,
  GameState,
  GameStatus,
  RandomState,
  Ruleset,
} from "@g2048/contracts";
import { E } from "./engine-api.js";
import type { EngineErrorLike } from "./engine-api.js";

// ---------------------------------------------------------------- immutability

/** Recursively freezes; any engine write to an input then throws in strict-mode ESM. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Deep-cloned, deep-frozen copy: the only form in which tests hand inputs to the engine. */
export function frozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

// ---------------------------------------------------------------- errors

/** Asserts a typed EngineError; pass several codes only where the spec leaves the choice open. */
export function expectEngineError(
  fn: () => unknown,
  code: EngineErrorCode | readonly EngineErrorCode[],
): void {
  let caught: unknown = undefined;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  const want = typeof code === "string" ? [code] : code;
  expect(caught, `expected EngineError ${want.join("|")}, got no throw`).toBeDefined();
  expect(caught, `expected EngineError ${want.join("|")}, got ${String(caught)}`).toBeInstanceOf(
    E.EngineError,
  );
  expect(want).toContain((caught as EngineErrorLike).code);
}

// ---------------------------------------------------------------- rules / states

export function rulesFor(version: string, size: number, fourWeight = 1): Ruleset {
  if (version === "practice-v1") return practiceRuleset({ size, fourWeight, undo: true });
  const builtin = (RULESETS as Record<string, Ruleset>)[version];
  if (!builtin) throw new Error(`unknown ruleset ${version}`);
  return builtin;
}

export const CLASSIC = RULESETS["classic-v1"];

export function rulesForState(state: GameState): Ruleset {
  return rulesFor(state.rulesetVersion, state.board.size);
}

export function words(seed: string): RandomState {
  return E.deriveRandomState("2048-infinite/v1:", seed);
}

export function makeState(
  cells: readonly Cell[],
  opts: {
    size?: number;
    score?: string;
    acceptedMoves?: number;
    revision?: number;
    rng?: readonly [number, number, number, number];
    status?: GameStatus;
    celebrated2048?: boolean;
    rulesetVersion?: string;
  } = {},
): GameState {
  const size = opts.size ?? Math.round(Math.sqrt(cells.length));
  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: opts.rulesetVersion ?? (size === 4 ? "classic-v1" : "practice-v1"),
    board: { size, cells: [...cells] },
    score: opts.score ?? "0",
    acceptedMoves: opts.acceptedMoves ?? 0,
    revision: opts.revision ?? 0,
    rng: { algorithm: RNG_ALGORITHM, words: opts.rng ?? [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x12345678] },
    status: opts.status ?? "active",
    celebrated2048: opts.celebrated2048 ?? false,
  };
}

export function board(size: number, cells: readonly Cell[]): Board {
  if (cells.length !== size * size) throw new Error("bad test board");
  return { size, cells: [...cells] };
}

/** Builds a size×size board from row strings; "." is empty, tokens separated by spaces. */
export function rows(...lines: string[]): Board {
  const cells = lines.flatMap((line) =>
    line
      .trim()
      .split(/\s+/)
      .map((t) => (t === "." ? null : t)),
  );
  return board(lines.length, cells);
}

// ---------------------------------------------------------------- exact arithmetic

export function mass(b: Board): bigint {
  let total = 0n;
  for (const c of b.cells) if (c !== null) total += 1n << BigInt(c);
  return total;
}

export function tileCount(b: Board): number {
  return b.cells.filter((c) => c !== null).length;
}

/** Clockwise rotation: the old top edge becomes the right edge, so up -> right. */
export function rotateCw(b: Board): Board {
  const n = b.size;
  const cells: Cell[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) cells.push(b.cells[(n - 1 - c) * n + r] ?? null);
  return { size: n, cells };
}

/** Main-diagonal transpose: rows become columns, so left <-> up and right <-> down. */
export function transpose(b: Board): Board {
  const n = b.size;
  const cells: Cell[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) cells.push(b.cells[c * n + r] ?? null);
  return { size: n, cells };
}

export const ROTATE_CW_DIRECTION: Record<Direction, Direction> = {
  up: "right",
  right: "down",
  down: "left",
  left: "up",
};
export const TRANSPOSE_DIRECTION: Record<Direction, Direction> = {
  up: "left",
  left: "up",
  right: "down",
  down: "right",
};

// ---------------------------------------------------------------- golden vectors

type StateRecord = { state: GameState; canonicalJson: string; checksum: string };

export type EngineVectors = {
  seedDerivation: { seed: string; sha256: string; words: [number, number, number, number] }[];
  xoshiro: {
    label: string;
    seed: string | null;
    initialWords: [number, number, number, number];
    outputs: number[];
    wordsAfter: [number, number, number, number];
  }[];
  uniform: {
    seed: string;
    sequences: {
      n: number;
      limit: number;
      initialWords: [number, number, number, number];
      results: number[];
      rawDraws: number[];
      rejectedRawDraws: number[];
      rawDrawsConsumed: number;
      wordsAfter: [number, number, number, number];
    }[];
    rejectionCase: {
      seed: string;
      n: number;
      limit: number;
      initialWords: [number, number, number, number];
      rejectedRawDraws: number[];
      result: number;
      rawDrawsConsumed: number;
      wordsAfter: [number, number, number, number];
    };
  };
  newGame: ({
    size: number;
    seed: string;
    spawns: { index: number; exponent: string; emptyCount: number }[];
  } & StateRecord)[];
  moveSequences: {
    seed: string;
    size: number;
    directions: Direction[];
    initial: StateRecord;
    steps: {
      step: number;
      direction: Direction;
      changed: boolean;
      scoreDelta: string;
      spawn: { index: number; exponent: string } | null;
      score: string;
      acceptedMoves: number;
      revision: number;
      status: GameStatus;
      rngWords: [number, number, number, number];
      checksum: string;
    }[];
    noOpSteps: number[];
    final: StateRecord;
  }[];
  highValue: {
    direction: Direction;
    before: StateRecord;
    slide: {
      cells: Cell[];
      changed: boolean;
      merges: { to: number; exponent: string; value: string }[];
      scoreDelta: string;
      scoreDeltaDigits: number;
    };
    applyMove: {
      changed: boolean;
      scoreDelta: string;
      spawn: { index: number; exponent: string };
      after: StateRecord;
    };
  };
  transitions: {
    id: string;
    direction?: Direction;
    before?: StateRecord;
    changed?: boolean;
    scoreDelta?: string;
    after?: StateRecord;
    board?: Board;
    isGameOver?: boolean;
    legalMoves?: Direction[];
  }[];
};

export type SlideFixture = {
  vectors: {
    id: string;
    size: number;
    direction: Direction;
    before: Cell[];
    after: Cell[];
    scoreDelta: string;
    changed: boolean;
  }[];
};

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as T;
}

export const VECTORS = readJson<EngineVectors>("../vectors/engine-v1.json");
export const SLIDE_FIXTURE = readJson<SlideFixture>("../../fixtures/slide-v1.json");

export function transition(id: string): EngineVectors["transitions"][number] {
  const t = VECTORS.transitions.find((x) => x.id === id);
  if (!t) throw new Error(`missing transition vector ${id}`);
  return t;
}
