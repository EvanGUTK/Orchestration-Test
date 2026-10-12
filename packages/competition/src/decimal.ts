import { DECIMAL_PATTERN, EXPONENT_PATTERN } from "@g2048/contracts";
import type { Decimal, Exponent } from "@g2048/contracts";
import { fail } from "./errors.js";

/**
 * Exact ordering of canonical decimal strings. Canonical form has no leading zeros, so a
 * longer string is always larger and equal-length strings order lexically. Values are never
 * converted to a JS number, so scores far above 2^53 compare exactly.
 *
 * Local helper for COMP-001; @g2048/engine also exports compareDecimal and the two may be
 * deduplicated once the engine is integrated.
 */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  assertDecimal(a, "a");
  assertDecimal(b, "b");
  return compareCanonical(a, b);
}

/** Exponent order with `null` (empty board) below every exponent. */
export function compareExponent(a: Exponent | null, b: Exponent | null): -1 | 0 | 1 {
  if (a === null || b === null) {
    if (a !== null) assertExponent(a, "a");
    if (b !== null) assertExponent(b, "b");
    return a === b ? 0 : a === null ? -1 : 1;
  }
  assertExponent(a, "a");
  assertExponent(b, "b");
  return compareCanonical(a, b);
}

export function isDecimal(value: unknown): value is Decimal {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

export function isExponent(value: unknown): value is Exponent {
  return typeof value === "string" && EXPONENT_PATTERN.test(value);
}

export function assertDecimal(value: unknown, field: string): asserts value is Decimal {
  if (!isDecimal(value)) fail("VALIDATION_ERROR", `${field} must be a canonical decimal string`);
}

export function assertExponent(value: unknown, field: string): asserts value is Exponent {
  if (!isExponent(value)) fail("VALIDATION_ERROR", `${field} must be a canonical positive exponent string`);
}

export function assertExponentOrNull(value: unknown, field: string): asserts value is Exponent | null {
  if (value !== null) assertExponent(value, field);
}

function compareCanonical(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
