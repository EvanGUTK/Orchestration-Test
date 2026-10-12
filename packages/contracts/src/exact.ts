/**
 * Exact-value helpers. Tile exponents and scores are canonical base-10 strings
 * everywhere outside the engine; arithmetic uses BigInt and never Number.
 */
export type Decimal = string; // /^0$|^[1-9][0-9]*$/
export type Exponent = string; // positive Decimal; tile value is 2 ** exponent
export type Cell = Exponent | null; // null = empty; "1" = 2, "2" = 4

const DECIMAL = /^(0|[1-9][0-9]*)$/;
export const MAX_DECIMAL_DIGITS = 4_000_000; // hard guard for any decimal string accepted from outside

export function isDecimal(value: unknown): value is Decimal {
  return typeof value === "string" && value.length <= MAX_DECIMAL_DIGITS && DECIMAL.test(value);
}

export function isExponent(value: unknown): value is Exponent {
  return isDecimal(value) && value !== "0";
}

/** Compare canonical decimals without converting to Number: length first, then lexical. */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  return (BigInt(a) + BigInt(b)).toString();
}

/** 2 ** exponent as a canonical decimal. Throws RangeError when exponent exceeds `maxExponent`. */
export function tileValue(exponent: Exponent, maxExponent = 1_000_000): Decimal {
  const e = BigInt(exponent);
  if (e > BigInt(maxExponent)) throw new RangeError("exponent exceeds resource limit");
  return (1n << e).toString();
}

/** Default display threshold: render full decimal up to this exponent, else `2^n`. */
export const FULL_DECIMAL_DISPLAY_MAX_EXPONENT = 64;
export function formatTile(exponent: Exponent, style: "auto" | "power" | "decimal" = "auto"): string {
  if (style === "power") return `2^${exponent}`;
  if (style === "decimal" || BigInt(exponent) <= BigInt(FULL_DECIMAL_DISPLAY_MAX_EXPONENT)) {
    return tileValue(exponent);
  }
  return `2^${exponent}`;
}

/** Operational limit: exponent strings longer than this are rejected with RESOURCE_LIMIT. */
export const MAX_EXPONENT_DIGITS = 7;
