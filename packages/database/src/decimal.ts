import { DECIMAL_PATTERN } from "@g2048/contracts";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * SQL ORDER BY fragment for canonical decimal TEXT columns: `length(col) DIR, col DIR`.
 * Canonical decimals have no leading zeros, so longer means larger and equal lengths compare
 * correctly with SQLite's BINARY collation. Never CAST to REAL/INTEGER (precision loss/overflow).
 * The column is validated as a plain identifier so this cannot inject SQL.
 */
export function decimalOrderBy(column: string, direction: "ASC" | "DESC" = "DESC"): string {
  if (!IDENTIFIER.test(column)) throw new Error(`Invalid column identifier: ${column}`);
  if (direction !== "ASC" && direction !== "DESC") throw new Error(`Invalid direction: ${String(direction)}`);
  return `length(${column}) ${direction}, ${column} ${direction}`;
}

export function isCanonicalDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

/** Exact comparison of canonical decimal strings without numeric conversion: -1, 0 or 1. */
export function compareCanonicalDecimal(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
