/**
 * Synthetic leaderboard dataset + independent ordering oracle for OPS-04 / DB-08.
 * Ordering (docs/ARCHITECTURE.md "Database model"): score by canonical decimal LENGTH then lexical, then max exponent
 * by length then lexical (higher is better, both descending), then created_at and id ascending for a total stable order.
 * (Direction of the last two tie-breakers is not stated in the docs; ascending = earlier/lower id first is assumed and reported.)
 */
import { OracleRng, deriveWords } from "../../integration/oracle/prng.ts";

export type Entry = { id: string; accountId: string; score: string; maxExponent: string; createdAt: string };

function cmpDec(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEntries(a: Entry, b: Entry): number {
  return (
    cmpDec(b.score, a.score) ||
    cmpDec(b.maxExponent, a.maxExponent) ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Deterministic dataset with: scores far above 2^53, equal-length lexical ties, exact duplicates, and exponent ties. */
export function generateEntries(count: number, seed = "ops04"): Entry[] {
  const rng = new OracleRng(deriveWords(seed));
  const out: Entry[] = [];
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i++) {
    const digits = 1 + rng.below(60); // up to 60-digit scores, well beyond float and 64-bit range
    let s = String(1 + rng.below(9));
    for (let d = 1; d < digits; d++) s += String(rng.below(10));
    if (i % 97 === 0 && out.length > 0) s = out[rng.below(out.length)]!.score; // force exact score ties
    const exp = String(1 + rng.below(rng.below(4) === 0 ? 5000 : 40));
    out.push({
      id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
      accountId: `acct-${rng.below(5000)}`,
      score: s,
      maxExponent: exp,
      createdAt: new Date(base + rng.below(86_400_000 * 30)).toISOString(),
    });
  }
  return out;
}

export function sortedEntries(entries: readonly Entry[]): Entry[] {
  return entries.slice().sort(compareEntries);
}

/** A float-casting (wrong) comparator, exported so tests can prove the dataset really punishes REAL sorting. */
export function floatOrder(entries: readonly Entry[]): Entry[] {
  return entries.slice().sort((a, b) => Number(b.score) - Number(a.score));
}
