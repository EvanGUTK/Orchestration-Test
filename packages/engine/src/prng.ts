import { DomainError, PRNG_ALGORITHM, SEED_NAMESPACE } from "@2048/contracts";
import type { RandomState } from "@2048/contracts";
import { sha256Bytes } from "./sha256.ts";

const TWO_32 = 4294967296;

export type Words = [number, number, number, number];

export function isUint32(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
}

/** Throws VALIDATION_ERROR unless `words` is four uint32 values that are not all zero. */
export function assertWords(words: unknown): asserts words is Words {
  if (!Array.isArray(words) || words.length !== 4 || !words.every(isUint32)) {
    throw new DomainError("VALIDATION_ERROR", "rng words must be four uint32 values");
  }
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
    throw new DomainError("VALIDATION_ERROR", "rng state must not be all zero");
  }
}

/** xoshiro128** over four uint32 words. Mutable; internal engine paths copy words in and out. */
export class Xoshiro {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
  constructor(words: readonly number[]) {
    this.s0 = words[0] as number;
    this.s1 = words[1] as number;
    this.s2 = words[2] as number;
    this.s3 = words[3] as number;
  }

  next(): number {
    const s1 = this.s1;
    const m = Math.imul(s1, 5);
    const r = (m << 7) | (m >>> 25);
    const result = Math.imul(r, 9) >>> 0;
    const t = s1 << 9;
    let s2 = (this.s2 ^ this.s0) >>> 0;
    let s3 = (this.s3 ^ s1) >>> 0;
    const n1 = (s1 ^ s2) >>> 0;
    const n0 = (this.s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = ((s3 << 11) | (s3 >>> 21)) >>> 0;
    this.s0 = n0;
    this.s1 = n1;
    this.s2 = s2;
    this.s3 = s3;
    return result;
  }

  /** Unbiased draw in [0, n): limit = 2^32 - (2^32 mod n); redraw while x >= limit. n = 1 still consumes a draw. */
  below(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
      throw new DomainError("VALIDATION_ERROR", "below(n) requires an integer 1 <= n <= 2^32");
    }
    const limit = TWO_32 - (TWO_32 % n);
    for (;;) {
      const x = this.next();
      if (x < limit) return x % n;
    }
  }

  words(): Words {
    return [this.s0, this.s1, this.s2, this.s3];
  }
}

/** Seed words: SHA-256(UTF-8("<namespace>:<seed>")), first 16 bytes as four little-endian uint32. */
export function deriveSeedWords(seed: string, namespace: string = SEED_NAMESPACE): Words {
  if (typeof seed !== "string" || typeof namespace !== "string") {
    throw new DomainError("VALIDATION_ERROR", "seed and namespace must be strings");
  }
  const d = sha256Bytes(`${namespace}:${seed}`);
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const w: Words = [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)];
  return w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 ? [1, 0, 0, 0] : w;
}

export function createRng(words: readonly number[]): {
  next(): number;
  below(n: number): number;
  state(): RandomState;
} {
  assertWords(words);
  const x = new Xoshiro(words);
  return {
    next: () => x.next(),
    below: (n: number) => x.below(n),
    state: () => ({ algorithm: PRNG_ALGORITHM, words: x.words() }),
  };
}
