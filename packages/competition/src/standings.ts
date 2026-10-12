import type { Decimal, Exponent } from "@g2048/contracts";
import { compareDecimal, compareExponent } from "./decimal.js";
import { fail } from "./errors.js";

/**
 * A leaderboard row as ordered by LEADERBOARD_ORDER. `createdAt` must be a fixed-format
 * UTC timestamp (ISO-8601 with identical precision, e.g. `2026-10-12T10:00:00.000Z`) or an
 * equivalent zero-padded sequence so code-unit order equals time order. Challenge standings
 * pass the attempt creation time.
 */
export type Standing = {
  readonly id: string;
  readonly score: Decimal;
  readonly maxExponent: Exponent | null;
  readonly createdAt: string;
};

/**
 * LEADERBOARD_ORDER total order: score desc, maxExponent desc, createdAt asc, id asc.
 * Returns a negative number when `x` ranks before `y`. Strings compare by UTF-16 code unit
 * (never locale-aware), so the order is identical on every machine. Equal only for equal keys.
 */
export function compareStanding(x: Standing, y: Standing): -1 | 0 | 1 {
  const byScore = compareDecimal(y.score, x.score);
  if (byScore !== 0) return byScore;
  const byExponent = compareExponent(y.maxExponent, x.maxExponent);
  if (byExponent !== 0) return byExponent;
  const byCreated = compareCodeUnits(x.createdAt, y.createdAt, "createdAt");
  if (byCreated !== 0) return byCreated;
  return compareCodeUnits(x.id, y.id, "id");
}

/** Returns a new array sorted by compareStanding; the input is not mutated. */
export function sortStandings<T extends Standing>(rows: readonly T[]): T[] {
  return [...rows].sort(compareStanding);
}

function compareCodeUnits(a: string, b: string, field: string): -1 | 0 | 1 {
  if (typeof a !== "string" || typeof b !== "string") fail("VALIDATION_ERROR", `${field} must be a string`);
  return a === b ? 0 : a < b ? -1 : 1;
}
