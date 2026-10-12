import { compareDecimal, formatTile } from "@2048/contracts";
import type { Decimal, Exponent, Preferences } from "@2048/contracts";

/** Insert thin grouping separators into a canonical decimal string. Never converts to Number. */
export function groupDecimal(value: Decimal, separator = " "): string {
  if (value.length <= 4) return value;
  if (value.length > 30) return compactDecimal(value);
  const head = value.length % 3;
  const parts: string[] = [];
  if (head > 0) parts.push(value.slice(0, head));
  for (let i = head; i < value.length; i += 3) parts.push(value.slice(i, i + 3));
  return parts.join(separator);
}

/** Long scores: leading digits plus digit count, still derived from the string (exact value stays in the title). */
export function compactDecimal(value: Decimal): string {
  return `${value.slice(0, 1)}.${value.slice(1, 6)}e+${value.length - 1}`;
}

/** Largest exponent rendered as a full decimal on a tile (2^39 has 12 digits); beyond that 2^n is clearer. */
export const TILE_DECIMAL_MAX_EXPONENT = 39n;

export function tileLabel(exponent: Exponent, style: Preferences["tileStyle"]): string {
  if (style === "powers") return formatTile(exponent, "power");
  return formatTile(exponent, BigInt(exponent) <= TILE_DECIMAL_MAX_EXPONENT ? "decimal" : "power");
}

/** Spoken form for screen readers: "tile 2 to the 12" style avoids reading huge decimals digit by digit. */
export function tileSpoken(exponent: Exponent): string {
  return BigInt(exponent) <= 20n ? formatTile(exponent, "decimal") : `2 to the power ${exponent}`;
}

export function maxExponentOf(cells: readonly (Exponent | null)[]): Exponent | null {
  let best: Exponent | null = null;
  for (const cell of cells) {
    if (cell !== null && (best === null || compareDecimal(cell, best) > 0)) best = cell;
  }
  return best;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
