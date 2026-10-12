import { readFileSync } from "node:fs";
import { BOT_SEED_NAMESPACE, RNG_ALGORITHM, SEED_NAMESPACE } from "@g2048/contracts";
import type { RandomState } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.js";
import { deriveRandomState, nextUint32, uniform, wordsFromDigest } from "./rng.js";
import { sha256Hex, toHex, utf8Bytes } from "./sha256.js";

type Words = [number, number, number, number];
type Vectors = {
  seedDerivation: { seed: string; hashInputUtf8Hex: string; sha256: string; words: Words }[];
  xoshiro: {
    label: string;
    seed: string | null;
    initialWords: Words;
    outputs: number[];
    wordsAfter: Words;
  }[];
  uniform: {
    seed: string;
    sequences: {
      n: number;
      limit: number;
      initialWords: Words;
      results: number[];
      rawDraws: number[];
      rejectedRawDraws: number[];
      rawDrawsConsumed: number;
      wordsAfter: Words;
    }[];
    rejectionCase: {
      seed: string;
      n: number;
      limit: number;
      initialWords: Words;
      rawDraws: { raw: number; accepted: boolean }[];
      rejectedRawDraws: number[];
      result: number;
      rawDrawsConsumed: number;
      wordsAfter: Words;
    };
  };
};

const vectors = JSON.parse(
  readFileSync(new URL("../../contracts/vectors/engine-v1.json", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  ),
) as Vectors;

const state = (words: Words): RandomState =>
  Object.freeze({ algorithm: RNG_ALGORITHM, words: Object.freeze(words) });

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof EngineError ? error.code : "RAW";
  }
}

describe("seed derivation (ENG-10)", () => {
  it("covers all six vectors", () => expect(vectors.seedDerivation).toHaveLength(6));
  for (const v of vectors.seedDerivation) {
    it(`seed ${JSON.stringify(v.seed)}`, () => {
      expect(toHex(utf8Bytes(SEED_NAMESPACE + v.seed))).toBe(v.hashInputUtf8Hex);
      expect(sha256Hex(SEED_NAMESPACE + v.seed)).toBe(v.sha256);
      expect(deriveRandomState(SEED_NAMESPACE, v.seed)).toEqual({ algorithm: RNG_ALGORITHM, words: v.words });
    });
  }

  it("substitutes [1,0,0,0] for an all-zero digest prefix", () => {
    expect(wordsFromDigest(new Uint8Array(32))).toEqual([1, 0, 0, 0]);
    const digest = new Uint8Array(32);
    digest[16] = 9; // bytes past 16 are ignored
    expect(wordsFromDigest(digest)).toEqual([1, 0, 0, 0]);
    digest[4] = 1;
    expect(wordsFromDigest(digest)).toEqual([0, 1, 0, 0]);
  });

  it("separates the bot namespace from the game namespace", () => {
    expect(deriveRandomState(BOT_SEED_NAMESPACE, "abc")).not.toEqual(
      deriveRandomState(SEED_NAMESPACE, "abc"),
    );
  });
});

describe("xoshiro128** (ENG-10)", () => {
  for (const v of vectors.xoshiro) {
    it(v.label, () => {
      if (v.seed !== null) expect(deriveRandomState(SEED_NAMESPACE, v.seed).words).toEqual(v.initialWords);
      let rng = state(v.initialWords);
      const outputs: number[] = [];
      for (let i = 0; i < v.outputs.length; i += 1) {
        const before = rng;
        const [value, next] = nextUint32(rng);
        expect(before.words).toEqual(rng.words); // input untouched
        outputs.push(value);
        rng = next;
      }
      expect(outputs).toEqual(v.outputs);
      expect(rng.words).toEqual(v.wordsAfter);
      expect(rng.algorithm).toBe(RNG_ALGORITHM);
    });
  }
});

describe("uniform rejection sampling (ENG-10)", () => {
  for (const v of vectors.uniform.sequences) {
    it(`n=${v.n}`, () => {
      expect(v.initialWords).toEqual(deriveRandomState(SEED_NAMESPACE, vectors.uniform.seed).words);
      let rng = state(v.initialWords);
      const results: number[] = [];
      for (let i = 0; i < v.results.length; i += 1) {
        const [value, next] = uniform(rng, v.n);
        results.push(value);
        rng = next;
      }
      expect(results).toEqual(v.results);
      expect(rng.words).toEqual(v.wordsAfter);

      let raw = state(v.initialWords);
      const draws: number[] = [];
      for (let i = 0; i < v.rawDrawsConsumed; i += 1) {
        const [value, next] = nextUint32(raw);
        draws.push(value);
        raw = next;
      }
      expect(draws).toEqual(v.rawDraws);
      expect(raw.words).toEqual(v.wordsAfter);
    });
  }

  it("rejectionCase: rejected raw draws advance the state", () => {
    const v = vectors.uniform.rejectionCase;
    expect(deriveRandomState(SEED_NAMESPACE, v.seed).words).toEqual(v.initialWords);
    expect(v.rejectedRawDraws.length).toBeGreaterThan(0);
    const [value, next] = uniform(state(v.initialWords), v.n);
    expect(value).toBe(v.result);
    expect(next.words).toEqual(v.wordsAfter);
    let raw = state(v.initialWords);
    for (const draw of v.rawDraws) {
      const [x, after] = nextUint32(raw);
      expect(x).toBe(draw.raw);
      expect(x < v.limit).toBe(draw.accepted);
      raw = after;
    }
    expect(raw.words).toEqual(v.wordsAfter);
  });

  it("uniform(1) still consumes one draw", () => {
    const start = state([1, 2, 3, 4]);
    const [value, next] = uniform(start, 1);
    expect(value).toBe(0);
    expect(next.words).toEqual(nextUint32(start)[1].words);
  });

  it("rejects bad bounds and invalid states with VALIDATION_ERROR", () => {
    const ok = state([1, 2, 3, 4]);
    for (const n of [0, -1, 1.5, 2 ** 32 + 1, Number.NaN, Infinity]) {
      expect(codeOf(() => uniform(ok, n))).toBe("VALIDATION_ERROR");
    }
    expect(codeOf(() => uniform(ok, 2 ** 32))).toBeNull();
    expect(codeOf(() => nextUint32(state([0, 0, 0, 0])))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => nextUint32(state([2 ** 32, 0, 0, 0])))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => nextUint32(state([-1, 0, 0, 0])))).toBe("VALIDATION_ERROR");
    expect(
      codeOf(() => nextUint32({ algorithm: "mt19937", words: [1, 2, 3, 4] } as unknown as RandomState)),
    ).toBe("VALIDATION_ERROR");
    expect(
      codeOf(() => nextUint32({ algorithm: RNG_ALGORITHM, words: [1, 2, 3] } as unknown as RandomState)),
    ).toBe("VALIDATION_ERROR");
    expect(codeOf(() => deriveRandomState(SEED_NAMESPACE, 5 as unknown as string))).toBe("VALIDATION_ERROR");
  });
});
