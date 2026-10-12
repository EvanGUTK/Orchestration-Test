// ENG-09 | Malformed state/resource pressure
// Pass evidence: typed rejection, no mutation/truncation or corrupted save.
import { describe, expect, it } from "vitest";
import { LIMITS, RULESETS, practiceRuleset } from "@g2048/contracts";
import type { Direction, EngineErrorCode, GameState, Ruleset } from "@g2048/contracts";
import { E } from "./engine-api.js";
import { CLASSIC, expectEngineError, frozen, makeState, rows } from "./helpers.js";

const VALID = makeState(rows("1 1 . .", ". 2 . .", ". . . .", ". . . 3").cells, {
  score: "40",
  acceptedMoves: 4,
  revision: 4,
});

// Version identifiers (schemaVersion, engineVersion, rng algorithm id) that the engine does not support
// are REPLAY_VERSION_UNSUPPORTED (chief-relayed engine reading, 2026-10-12); every other malformed
// field is VALIDATION_ERROR.
type Mutation = { name: string; mutate: (s: Record<string, unknown>) => void; code?: EngineErrorCode };
const set =
  (path: string[], value: unknown): Mutation["mutate"] =>
  (s) => {
    let o: Record<string, unknown> = s;
    for (const k of path.slice(0, -1)) o = o[k] as Record<string, unknown>;
    o[path.at(-1) as string] = value;
  };

const MALFORMED: Mutation[] = [
  { name: "schemaVersion 2", mutate: set(["schemaVersion"], 2), code: "REPLAY_VERSION_UNSUPPORTED" },
  {
    name: "unsupported engineVersion",
    mutate: set(["engineVersion"], "9.9.9"),
    code: "REPLAY_VERSION_UNSUPPORTED",
  },
  { name: "missing score", mutate: (s) => delete s.score },
  { name: "score with leading zero", mutate: set(["score"], "040") },
  { name: "score as JSON number", mutate: set(["score"], 40) },
  { name: "negative score", mutate: set(["score"], "-4") },
  { name: "fractional score", mutate: set(["score"], "4.5") },
  { name: "cells length != size^2", mutate: set(["board", "cells"], ["1", null, null]) },
  { name: "board size 0", mutate: set(["board", "size"], 0) },
  { name: 'exponent "0"', mutate: set(["board", "cells", "0"], "0") },
  { name: "exponent with leading zero", mutate: set(["board", "cells", "0"], "01") },
  { name: "exponent as number", mutate: set(["board", "cells", "0"], 1) },
  { name: "exponent negative", mutate: set(["board", "cells", "0"], "-1") },
  { name: "exponent non-decimal", mutate: set(["board", "cells", "0"], "1e3") },
  { name: "all-zero rng", mutate: set(["rng", "words"], [0, 0, 0, 0]) },
  { name: "rng word >= 2^32", mutate: set(["rng", "words", "0"], 4294967296) },
  { name: "rng word negative", mutate: set(["rng", "words", "1"], -1) },
  { name: "rng word fractional", mutate: set(["rng", "words", "2"], 1.5) },
  { name: "rng 3 words", mutate: set(["rng", "words"], [1, 2, 3]) },
  {
    name: "unknown rng algorithm",
    mutate: set(["rng", "algorithm"], "mt19937"),
    code: "REPLAY_VERSION_UNSUPPORTED",
  },
  { name: "unknown status", mutate: set(["status"], "paused") },
  { name: "negative revision", mutate: set(["revision"], -1) },
  { name: "fractional acceptedMoves", mutate: set(["acceptedMoves"], 1.5) },
  { name: "celebrated2048 as string", mutate: set(["celebrated2048"], "false") },
];

function malformed(m: Mutation): GameState {
  const s = structuredClone(VALID) as unknown as Record<string, unknown>;
  m.mutate(s);
  return frozen(s as unknown as GameState);
}

describe("ENG-09 malformed state and resource pressure", () => {
  describe("deserialize rejects malformed input with a typed error", () => {
    for (const m of MALFORMED) {
      it(`${m.name} -> ${m.code ?? "VALIDATION_ERROR"}`, () => {
        expectEngineError(() => E.deserialize(JSON.stringify(malformed(m))), m.code ?? "VALIDATION_ERROR");
      });
    }
    it("non-JSON, truncated JSON, empty string, JSON null/array", () => {
      const good = E.serialize(frozen(VALID));
      for (const text of ["not json", good.slice(0, good.length - 7), "", "null", "[]", "{}"]) {
        expectEngineError(() => E.deserialize(text), "VALIDATION_ERROR");
      }
    });
  });

  describe("applyMove rejects malformed state with a typed error and never mutates it", () => {
    for (const m of MALFORMED) {
      it(`${m.name} -> ${m.code ?? "VALIDATION_ERROR"}`, () => {
        const bad = malformed(m);
        const snapshot = JSON.stringify(bad);
        expectEngineError(() => E.applyMove(bad, "left", CLASSIC), m.code ?? "VALIDATION_ERROR");
        expect(JSON.stringify(bad)).toBe(snapshot);
      });
    }
  });

  it("invalid direction is VALIDATION_ERROR", () => {
    expectEngineError(() => E.applyMove(frozen(VALID), "north" as Direction, CLASSIC), "VALIDATION_ERROR");
    expectEngineError(() => E.slide(frozen(VALID.board), "" as Direction), "VALIDATION_ERROR");
  });

  it("rules that do not match the state board size are VALIDATION_ERROR", () => {
    const rules3 = practiceRuleset({ size: 3, fourWeight: 1, undo: true });
    expectEngineError(() => E.applyMove(frozen(VALID), "left", rules3), "VALIDATION_ERROR");
  });

  it("newGame rejects out-of-range rules (size, fourWeight) with VALIDATION_ERROR", () => {
    const bad: Ruleset[] = [
      { ...practiceRuleset({ size: 3, fourWeight: 1, undo: true }), size: 2 },
      { ...practiceRuleset({ size: 8, fourWeight: 1, undo: true }), size: 9 },
      { ...RULESETS["classic-v1"], fourWeight: 11 },
      { ...RULESETS["classic-v1"], fourWeight: -1 },
      { ...RULESETS["classic-v1"], fourWeight: 0.5 },
    ];
    for (const rules of bad) expectEngineError(() => E.newGame(frozen(rules), "x"), "VALIDATION_ERROR");
  });

  it("uniform/nextUint32 reject invalid bounds and the all-zero state with VALIDATION_ERROR", () => {
    const rng = frozen(E.deriveRandomState("2048-infinite/v1:", "abc"));
    for (const n of [0, -1, 1.5, 4294967297, Number.NaN])
      expectEngineError(() => E.uniform(rng, n), "VALIDATION_ERROR");
    expectEngineError(
      () => E.nextUint32(frozen({ algorithm: "xoshiro128ss-v1", words: [0, 0, 0, 0] as const })),
      "VALIDATION_ERROR",
    );
  });

  describe("resource guard (LIMITS.maxExponent)", () => {
    const max = LIMITS.maxExponent;

    it("merging two maxExponent tiles throws RESOURCE_LIMIT from slide and applyMove; input preserved", () => {
      const cells = rows(`${max} ${max} . .`, ". . . .", ". . . .", ". . . .").cells;
      const state = frozen(makeState(cells, { celebrated2048: true }));
      const snapshot = E.serialize(state);
      expectEngineError(() => E.slide(state.board, "left"), "RESOURCE_LIMIT");
      expectEngineError(() => E.applyMove(state, "left", CLASSIC), "RESOURCE_LIMIT");
      expect(E.serialize(state)).toBe(snapshot);
    });

    // OPEN (flagged to chief): a state that already holds an exponent above maxExponent can never be produced
    // by the engine; the spec does not say whether that is malformed input or resource pressure. Either typed
    // code passes; what is required is a fast typed rejection with the input preserved.
    it(
      "an astronomically large exponent pair is refused before computing the power (fast)",
      { timeout: 2_000 },
      () => {
        const huge = "9".repeat(40);
        const state = frozen(
          makeState(rows(`${huge} ${huge} . .`, ". . . .", ". . . .", ". . . .").cells, {
            celebrated2048: true,
          }),
        );
        const snapshot = JSON.stringify(state);
        const t0 = performance.now();
        expectEngineError(() => E.applyMove(state, "left", CLASSIC), ["RESOURCE_LIMIT", "VALIDATION_ERROR"]);
        expectEngineError(() => E.slide(state.board, "left"), ["RESOURCE_LIMIT", "VALIDATION_ERROR"]);
        expect(JSON.stringify(state)).toBe(snapshot);
        expect(performance.now() - t0).toBeLessThan(1_000);
      },
    );

    it("creating exactly maxExponent is allowed and exact (no truncation)", { timeout: 60_000 }, () => {
      const e = String(max - 1);
      const res = E.slide(frozen(rows(`${e} ${e} . .`, ". . . .", ". . . .", ". . . .")), "left");
      expect(res.board.cells[0]).toBe(String(max));
      // 2^1_000_000 has floor(1e6 * log10 2) + 1 = 301030 digits
      expect(res.scoreDelta).toHaveLength(301030);
      expect(res.scoreDelta.startsWith("9900656")).toBe(true);
      expect(res.scoreDelta.endsWith("09376")).toBe(true);
    });
  });

  it("a save round trip never truncates: huge score + huge exponents survive serialize/deserialize", () => {
    const score = (1n << 20000n).toString();
    const state = frozen(
      makeState(rows("20000 4096 . .", ". . . .", ". . . .", ". . . 1").cells, {
        score,
        celebrated2048: true,
      }),
    );
    const back = E.deserialize(E.serialize(state));
    expect(back).toEqual(state);
    expect(back.score).toHaveLength(score.length);
  });
});
