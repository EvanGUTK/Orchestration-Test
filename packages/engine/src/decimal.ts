import { DECIMAL_PATTERN, EXPONENT_PATTERN, LIMITS } from "@g2048/contracts";
import type { Decimal, Exponent } from "@g2048/contracts";
import { EngineError, invalid } from "./errors.js";

/**
 * Exact arithmetic on canonical decimal strings. Values are only ever handled as strings or
 * BigInt; they are never converted to Number, parsed with parseInt/parseFloat, or 32-bit shifted.
 */

/** LIMITS.maxExponent as a canonical decimal string (a configuration constant, not a tile value). */
export const MAX_EXPONENT: Exponent = LIMITS.maxExponent.toString();

/** Canonical nonnegative integer string: /^0$|^[1-9][0-9]*$/. */
export function isDecimal(value: unknown): value is Decimal {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

/** Canonical positive integer string: /^[1-9][0-9]*$/. */
export function isExponent(value: unknown): value is Exponent {
  return typeof value === "string" && EXPONENT_PATTERN.test(value);
}

function requireDecimal(value: unknown, what: string): asserts value is Decimal {
  if (!isDecimal(value)) throw invalid(`${what} must be a canonical decimal string`);
}

/** Compare two already-canonical decimals without allocation (length first, then lexicographic). */
export function compareCanonical(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Exact comparison of canonical decimal strings. Throws VALIDATION_ERROR on non-canonical input. */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  requireDecimal(a, "a");
  requireDecimal(b, "b");
  return compareCanonical(a, b);
}

/** Exact sum of canonical decimal strings. */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  requireDecimal(a, "a");
  requireDecimal(b, "b");
  return addCanonical(a, b);
}

/** Sum of already-validated decimals. */
export function addCanonical(a: string, b: string): string {
  if (a === "0") return b;
  if (b === "0") return a;
  return (BigInt(a) + BigInt(b)).toString();
}

/** Throws RESOURCE_LIMIT if exponent (canonical) exceeds LIMITS.maxExponent. Nothing is allocated first. */
export function assertExponentWithinLimit(exponent: string): void {
  if (compareCanonical(exponent, MAX_EXPONENT) > 0) {
    throw new EngineError(
      "RESOURCE_LIMIT",
      `tile exponent ${exponent.length > 20 ? `${exponent.slice(0, 20)}...` : exponent} exceeds limit ${MAX_EXPONENT}`,
    );
  }
}

/** Exponents up to this many digits get their power and successor cached (e <= 999). */
const CACHE_MAX_DIGITS = 3;
const powCache = new Map<string, string>();
const nextCache = new Map<string, string>();

/** 2 ** exponent as an exact decimal string. RESOURCE_LIMIT is checked before computing the power. */
export function pow2Decimal(exponent: Exponent): Decimal {
  if (!isExponent(exponent)) throw invalid("exponent must be a canonical positive decimal string");
  return pow2Canonical(exponent);
}

/** pow2Decimal for an already-validated exponent. */
export function pow2Canonical(exponent: string): string {
  const cached = powCache.get(exponent);
  if (cached !== undefined) return cached;
  assertExponentWithinLimit(exponent);
  const value = (1n << BigInt(exponent)).toString();
  if (exponent.length <= CACHE_MAX_DIGITS) powCache.set(exponent, value);
  return value;
}

/** exponent + 1 as a canonical string; RESOURCE_LIMIT if the result exceeds LIMITS.maxExponent. */
export function nextExponent(exponent: string): string {
  const cached = nextCache.get(exponent);
  if (cached !== undefined) return cached;
  const next = incrementCanonical(exponent);
  assertExponentWithinLimit(next);
  if (exponent.length <= CACHE_MAX_DIGITS) nextCache.set(exponent, next);
  return next;
}

/** Decimal string + 1 by carrying over digits (no numeric conversion). */
function incrementCanonical(value: string): string {
  let i = value.length - 1;
  while (i >= 0 && value.charCodeAt(i) === 57 /* '9' */) i -= 1;
  if (i < 0) return `1${"0".repeat(value.length)}`;
  const digit = String.fromCharCode(value.charCodeAt(i) + 1);
  return value.slice(0, i) + digit + "0".repeat(value.length - 1 - i);
}
