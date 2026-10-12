// ENG-10 | PRNG golden vectors
// Pass evidence: independent reviewer verifies xoshiro output/seed mapping/draw order.
// Vectors: tests/acceptance/vectors/engine-v1.json (QA-001 independent Python oracle; frozen as
// packages/contracts/vectors/engine-v1.json, SHA-256 e7247481...).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOT_SEED_NAMESPACE, RNG_ALGORITHM, SEED_NAMESPACE } from "@g2048/contracts";
import type { RandomState } from "@g2048/contracts";
import { CONTRACT_EXPORTS, E, engineExports } from "./engine-api.js";
import { VECTORS, frozen, rulesFor } from "./helpers.js";

const rngOf = (w: readonly [number, number, number, number]): RandomState =>
  frozen({ algorithm: RNG_ALGORITHM, words: [w[0], w[1], w[2], w[3]] as const });

describe("ENG-API engine exports the CONTRACT-001 public API", () => {
  for (const name of CONTRACT_EXPORTS) {
    it(`exports ${name}`, () => expect(typeof engineExports[name]).toBe("function"));
  }
});

describe("ENG-10 PRNG golden vectors", () => {
  it("vector file is the frozen contract copy (byte-identical, LF)", () => {
    const sha = (rel: string) =>
      createHash("sha256")
        .update(readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n"), "utf8")
        .digest("hex");
    const ours = sha("../vectors/engine-v1.json");
    expect(ours).toBe("e72474813ba02f21c3c68b9e6b94c7fa33ff696abe9d30b7cc63b23645c29f28");
    expect(sha("../../../packages/contracts/vectors/engine-v1.json")).toBe(ours);
  });

  describe("seed derivation", () => {
    for (const v of VECTORS.seedDerivation) {
      it(`seed ${JSON.stringify(v.seed)}`, () => {
        expect(E.deriveRandomState(SEED_NAMESPACE, v.seed)).toEqual({
          algorithm: RNG_ALGORITHM,
          words: v.words,
        });
      });
    }
    it("bot namespace yields a different stream than the game namespace", () => {
      for (const v of VECTORS.seedDerivation) {
        expect(E.deriveRandomState(BOT_SEED_NAMESPACE, v.seed).words).not.toEqual(v.words);
      }
    });
  });

  describe("xoshiro128** outputs", () => {
    for (const v of VECTORS.xoshiro) {
      it(`${v.label}: first ${v.outputs.length} outputs and final words`, () => {
        let rng = rngOf(v.initialWords);
        const out: number[] = [];
        for (let i = 0; i < v.outputs.length; i++) {
          const [x, next] = E.nextUint32(rng);
          expect(Number.isInteger(x) && x >= 0 && x <= 0xffffffff).toBe(true);
          out.push(x);
          rng = frozen(next);
        }
        expect(out).toEqual(v.outputs);
        expect(rng.words).toEqual(v.wordsAfter);
        expect(rng.algorithm).toBe(RNG_ALGORITHM);
      });
    }
    it("matches the published reference stream for state [1,2,3,4]", () => {
      const ref = VECTORS.xoshiro.find((x) => x.label === "reference-state-1-2-3-4");
      expect(ref?.outputs.slice(0, 4)).toEqual([11520, 0, 5927040, 70819200]);
    });
  });

  describe("uniform(n) rejection sampling", () => {
    for (const s of VECTORS.uniform.sequences) {
      it(`n=${s.n}: 10 draws and final words (${s.rawDrawsConsumed} raw draws)`, () => {
        let rng = rngOf(s.initialWords);
        const got: number[] = [];
        for (let i = 0; i < s.results.length; i++) {
          const [x, next] = E.uniform(rng, s.n);
          got.push(x);
          rng = frozen(next);
        }
        expect(got).toEqual(s.results);
        expect(rng.words).toEqual(s.wordsAfter);
      });
    }
    it("rejection case: rejected raw draws still advance the state", () => {
      const r = VECTORS.uniform.rejectionCase;
      expect(r.rejectedRawDraws.length).toBeGreaterThan(0);
      const [x, next] = E.uniform(rngOf(r.initialWords), r.n);
      expect(x).toBe(r.result);
      expect(next.words).toEqual(r.wordsAfter);
      // equivalently: exactly rawDrawsConsumed nextUint32 steps
      let rng = rngOf(r.initialWords);
      for (let i = 0; i < r.rawDrawsConsumed; i++) rng = frozen(E.nextUint32(rng)[1]);
      expect(rng.words).toEqual(r.wordsAfter);
    });
    it("uniform(1) returns 0 and consumes exactly one raw draw", () => {
      const start = rngOf(VECTORS.uniform.sequences[0]?.initialWords ?? [1, 2, 3, 4]);
      const [x, next] = E.uniform(start, 1);
      expect(x).toBe(0);
      expect(next.words).toEqual(E.nextUint32(start)[1].words);
    });
  });

  describe("newGame spawn draw order (position then value, twice)", () => {
    for (const g of VECTORS.newGame) {
      it(`size ${g.size} seed ${JSON.stringify(g.seed)}`, () => {
        const rules = rulesFor(g.state.rulesetVersion, g.size);
        const state = E.newGame(frozen(rules), g.seed);
        expect(state).toEqual(g.state);
        expect(E.canonicalJson(state)).toBe(g.canonicalJson);
        expect(E.checksum(state)).toBe(g.checksum);
        // independently re-derive the two spawns from the PRNG primitives
        let rng = frozen(E.deriveRandomState(SEED_NAMESPACE, g.seed));
        const empties = Array.from({ length: g.size * g.size }, (_, i) => i);
        for (const spawn of g.spawns) {
          const [k, r1] = E.uniform(rng, empties.length);
          const [v, r2] = E.uniform(frozen(r1), 10);
          rng = frozen(r2);
          expect(empties[k]).toBe(spawn.index);
          expect(v < rules.fourWeight ? "2" : "1").toBe(spawn.exponent);
          empties.splice(k, 1);
        }
        expect(rng.words).toEqual(g.state.rng.words);
      });
    }
  });

  describe("move sequences: per-step checksum and rng words", () => {
    for (const seq of VECTORS.moveSequences) {
      it(`seed ${seq.seed}: ${seq.steps.length} steps`, () => {
        let state = frozen(seq.initial.state);
        expect(E.checksum(state)).toBe(seq.initial.checksum);
        const rules = rulesFor(state.rulesetVersion, state.board.size);
        for (const step of seq.steps) {
          const res = E.applyMove(state, step.direction, rules);
          state = frozen(res.state);
          expect({ step: step.step, checksum: E.checksum(state), words: state.rng.words }).toEqual({
            step: step.step,
            checksum: step.checksum,
            words: step.rngWords,
          });
          expect(state.score).toBe(step.score);
          expect(state.revision).toBe(step.revision);
        }
        expect(E.canonicalJson(state)).toBe(seq.final.canonicalJson);
      });
    }
  });
});
