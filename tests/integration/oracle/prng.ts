/**
 * INDEPENDENT oracle for the 2048 Infinite PRNG, written from the prose in
 * docs/CONTRACTS.md ("Deterministic random protocol") and CONTRACT-001.md only.
 * It deliberately uses BigInt arithmetic (not Math.imul / >>> 0 tricks) and imports
 * nothing from @2048/* so a shared bug cannot hide in shared code.
 */
import { createHash } from "node:crypto";

export const SEED_NAMESPACE = "2048-infinite/v1";
export const BOT_SEED_NAMESPACE = "2048-infinite/v1/bot";

const M32 = 0xffffffffn;
const TWO32 = 1n << 32n;

export type Words = [number, number, number, number];

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (32n - k))) & M32;
}

/** SHA-256 of UTF-8 `<namespace>:<seed>`; first 16 bytes as four little-endian uint32 words. */
export function deriveWords(seed: string, namespace: string = SEED_NAMESPACE): Words {
  const digest = createHash("sha256").update(`${namespace}:${seed}`, "utf8").digest();
  const w: number[] = [];
  for (let i = 0; i < 4; i++) {
    w.push(digest[4 * i]! + digest[4 * i + 1]! * 256 + digest[4 * i + 2]! * 65536 + digest[4 * i + 3]! * 16777216);
  }
  if (w.every((x) => x === 0)) return [1, 0, 0, 0];
  return w as Words;
}

export class OracleRng {
  private s: [bigint, bigint, bigint, bigint];
  /** number of rejected (redrawn) values observed by below(); useful to prove goldens exercise rejection */
  rejections = 0;
  /** number of raw next() calls */
  draws = 0;

  constructor(words: readonly number[]) {
    if (words.length !== 4) throw new Error("need 4 words");
    for (const x of words) if (!Number.isInteger(x) || x < 0 || x > 0xffffffff) throw new Error("not uint32");
    if (words.every((x) => x === 0)) throw new Error("zero state invalid");
    this.s = [BigInt(words[0]!), BigInt(words[1]!), BigInt(words[2]!), BigInt(words[3]!)];
  }

  next(): number {
    this.draws++;
    let [s0, s1, s2, s3] = this.s;
    const result = (rotl((s1 * 5n) & M32, 7n) * 9n) & M32;
    const t = (s1 << 9n) & M32;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11n);
    this.s = [s0, s1, s2, s3];
    return Number(result);
  }

  /** Unbiased rejection sampling into [0, n). Always consumes at least one draw (even n === 1). */
  below(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new Error("bad n");
    const bn = BigInt(n);
    const limit = TWO32 - (TWO32 % bn);
    for (;;) {
      const x = BigInt(this.next());
      if (x < limit) return Number(x % bn);
      this.rejections++;
    }
  }

  words(): Words {
    return this.s.map((x) => Number(x)) as Words;
  }
}
