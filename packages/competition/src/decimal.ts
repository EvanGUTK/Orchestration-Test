import { DECIMAL_PATTERN, EXPONENT_PATTERN } from "@g2048/contracts";
import type { Decimal, Exponent } from "@g2048/contracts";
import { compareDecimal as engineCompareDecimal } from "@g2048/engine";
import { fail } from "./errors.js";

/**
 * Exact ordering of canonical decimal strings. Canonical form has no leading zeros, so a
 * longer string is always larger and equal-length strings order lexically. Values are never
 * converted to a JS number, so scores far above 2^53 compare exactly.
 *
 * Inputs are validated here (CompetitionError) and the ordering itself is delegated to
 * @g2048/engine's compareDecimal, so competition and engine share one comparison.
 */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  assertDecimal(a, "a");
  assertDecimal(b, "b");
  return engineCompareDecimal(a, b);
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
  // Canonical exponents are canonical decimals, so the engine's decimal order applies.
  return engineCompareDecimal(a, b);
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
