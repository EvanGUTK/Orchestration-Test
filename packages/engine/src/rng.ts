import { RNG_ALGORITHM } from "@g2048/contracts";
import type { RandomState } from "@g2048/contracts";
import { EngineError, invalid } from "./errors.js";
import { sha256, utf8Bytes } from "./sha256.js";

/**
 * Deterministic randomness, CONTRACT-001 decisions 1-3. All arithmetic is unsigned 32-bit with
 * wraparound on PRNG words (never on tile values).
 */

export type Words = [number, number, number, number];

const TWO_POW_32 = 0x100000000;

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < TWO_POW_32;
}

/**
 * Validates a RandomState. An unknown algorithm string is REPLAY_VERSION_UNSUPPORTED when
 * `unknownAlgorithmIsVersionError` is set (deserialization), otherwise VALIDATION_ERROR; bad or
 * all-zero words are VALIDATION_ERROR.
 */
export function validateRandomState(
  rng: unknown,
  unknownAlgorithmIsVersionError = false,
): asserts rng is RandomState {
  if (typeof rng !== "object" || rng === null) throw invalid("rng must be an object");
  const { algorithm, words } = rng as { algorithm?: unknown; words?: unknown };
  if (algorithm !== RNG_ALGORITHM) {
    if (unknownAlgorithmIsVersionError && typeof algorithm === "string") {
      throw new EngineError(
        "REPLAY_VERSION_UNSUPPORTED",
        `unsupported rng algorithm ${JSON.stringify(algorithm)}`,
      );
    }
    throw invalid(`rng.algorithm must be ${RNG_ALGORITHM}`);
  }
  if (!Array.isArray(words) || words.length !== 4 || !words.every(isUint32)) {
    throw invalid("rng.words must be four uint32 integers");
  }
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
    throw invalid("rng.words must not be all zero");
  }
}

/** First 16 digest bytes -> four little-endian uint32 words; all-zero -> [1,0,0,0]. */
export function wordsFromDigest(digest: Uint8Array): Words {
  if (digest.length < 16) throw invalid("digest must have at least 16 bytes");
  const view = new DataView(digest.buffer, digest.byteOffset, 16);
  const words: Words = [
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
    view.getUint32(12, true),
  ];
  return words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 ? [1, 0, 0, 0] : words;
}

/** SHA-256(UTF-8(namespace + seed)) -> xoshiro128ss-v1 state. Games use SEED_NAMESPACE; bots BOT_SEED_NAMESPACE. */
export function deriveRandomState(namespace: string, seed: string): RandomState {
  if (typeof namespace !== "string") throw invalid("namespace must be a string");
  if (typeof seed !== "string") throw invalid("seed must be a string");
  return { algorithm: RNG_ALGORITHM, words: wordsFromDigest(sha256(utf8Bytes(namespace + seed))) };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** One xoshiro128** step on mutable words; returns the uint32 output. */
export function step(s: Words): number {
  const s0 = s[0];
  const s1 = s[1];
  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  const s2 = (s[2] ^ s0) >>> 0;
  const s3 = (s[3] ^ s1) >>> 0;
  s[1] = (s1 ^ s2) >>> 0;
  s[0] = (s0 ^ s3) >>> 0;
  s[2] = (s2 ^ t) >>> 0;
  s[3] = rotl(s3, 11);
  return result;
}

function requireBound(n: unknown): asserts n is number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
    throw invalid("uniform bound must be an integer in 1..2^32");
  }
}

/**
 * Unbiased integer in [0, n) on mutable words: limit = 2^32 - (2^32 mod n); draw until x < limit.
 * Every raw draw advances the state, including rejected draws and the single draw for n = 1.
 */
export function uniformStep(s: Words, n: number): number {
  const limit = TWO_POW_32 - (TWO_POW_32 % n);
  for (;;) {
    const x = step(s);
    if (x < limit) return x % n;
  }
}

function wordsOf(rng: RandomState): Words {
  validateRandomState(rng);
  return [rng.words[0], rng.words[1], rng.words[2], rng.words[3]];
}

/** Next uint32 output and the advanced state. The input state is not mutated. */
export function nextUint32(rng: RandomState): [number, RandomState] {
  const s = wordsOf(rng);
  const value = step(s);
  return [value, { algorithm: RNG_ALGORITHM, words: s }];
}

/** Unbiased integer in [0, n), 1 <= n <= 2^32, and the advanced state. The input state is not mutated. */
export function uniform(rng: RandomState, n: number): [number, RandomState] {
  requireBound(n);
  const s = wordsOf(rng);
  const value = uniformStep(s, n);
  return [value, { algorithm: RNG_ALGORITHM, words: s }];
}
