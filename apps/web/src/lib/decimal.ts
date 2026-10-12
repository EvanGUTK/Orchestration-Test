import { DECIMAL_PATTERN, EXPONENT_PATTERN } from "@g2048/contracts";
import type { Decimal, Exponent } from "@g2048/contracts";

/**
 * Exact presentation helpers for tile and score values.
 * Values arrive as canonical decimal / exponent strings and are only ever handled as
 * strings or BigInt. Nothing in this module converts a game value to a JS Number.
 */

export function isDecimal(value: string): value is Decimal {
  return DECIMAL_PATTERN.test(value);
}

export function isExponent(value: string): value is Exponent {
  return EXPONENT_PATTERN.test(value);
}

/**
 * Exponents above this are never expanded to a full decimal string in the UI. 2^20000 already has
 * 6,021 digits, far beyond what anyone can read; the contract allows exponents up to 1,000,000.
 */
export const MAX_EXPANDED_EXPONENT = 20_000n;

const pow2Cache = new Map<string, Decimal>();

/** Exact decimal value of 2^exponent, or null when the exponent is too large to expand usefully. */
export function pow2Decimal(exponent: Exponent): Decimal | null {
  if (!isExponent(exponent)) throw new RangeError(`Invalid exponent: ${exponent}`);
  const cached = pow2Cache.get(exponent);
  if (cached !== undefined) return cached;
  const e = BigInt(exponent);
  if (e > MAX_EXPANDED_EXPONENT) return null;
  const value = (1n << e).toString();
  if (pow2Cache.size > 512) pow2Cache.clear();
  pow2Cache.set(exponent, value);
  return value;
}

/** Exact number of decimal digits of 2^exponent (floor(e*log10 2)+1), computed with BigInt only. */
export function pow2DigitCount(exponent: Exponent): bigint {
  const expanded = pow2Decimal(exponent);
  if (expanded !== null) return BigInt(expanded.length);
  // digits(2^e) = floor(e * log10(2)) + 1. Use a 40-digit fixed-point log10(2); exact for e <= 10^30.
  const LOG10_2 = 3010299956639811952137388947244930267681n; // log10(2) * 10^40, truncated
  const SCALE = 10n ** 40n;
  return (BigInt(exponent) * LOG10_2) / SCALE + 1n;
}

/** "1234567" -> "1,234,567". Pure string grouping; never parses the number. */
export function groupDigits(value: Decimal, separator = ","): string {
  if (!isDecimal(value)) throw new RangeError(`Invalid decimal: ${value}`);
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (i > 0 && (value.length - i) % 3 === 0) out += separator;
    out += value[i];
  }
  return out;
}

/** Compare two canonical decimals exactly. */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
