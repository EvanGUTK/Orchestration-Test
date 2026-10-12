import type { Decimal, Exponent } from "@g2048/contracts";
import { groupDigits, isDecimal, pow2Decimal, pow2DigitCount } from "./decimal.js";

export type TileDisplayStyle = "auto" | "value" | "exponent";

/**
 * Display thresholds (documented decision for FRONTEND-001):
 *  - "auto"     : full decimal while it has <= 6 digits (2^19 = 524,288); 2^20 and above render as 2^n.
 *  - "value"    : full decimal while it has <= 12 digits (2^39); beyond that a tile cannot fit it.
 *  - "exponent" : always 2^n.
 * The exact decimal is always available in the tile's tooltip (title) and the power form in its label.
 */
export const AUTO_MAX_DIGITS = 6n;
export const VALUE_MAX_DIGITS = 12n;
/** Accessible labels include the full decimal only while it is short enough to be listened to. */
export const LABEL_MAX_DIGITS = 24n;
/** Tooltips include the exact decimal up to this many digits (2^20000 has 6,021). */
export const TITLE_MAX_DIGITS = 7_000n;

export type TileDisplay = {
  readonly kind: "decimal" | "power";
  /** Plain-text visible label, e.g. "2048" or "2^4096". */
  readonly text: string;
  /** Base and exponent for superscript rendering when kind === "power". */
  readonly exponent: Exponent;
  readonly digits: bigint;
  readonly ariaLabel: string;
  readonly title: string;
};

export function tileDisplay(exponent: Exponent, style: TileDisplayStyle = "auto"): TileDisplay {
  const digits = pow2DigitCount(exponent);
  const limit = style === "exponent" ? 0n : style === "value" ? VALUE_MAX_DIGITS : AUTO_MAX_DIGITS;
  const decimal = digits <= TITLE_MAX_DIGITS ? pow2Decimal(exponent) : null;
  const power = `2^${exponent}`;
  if (digits <= limit && decimal !== null) {
    return {
      kind: "decimal",
      text: decimal,
      exponent,
      digits,
      ariaLabel: decimal,
      title: `${groupDigits(decimal)} (2^${exponent})`,
    };
  }
  const spoken =
    decimal !== null && digits <= LABEL_MAX_DIGITS
      ? `2 to the power ${exponent}, ${decimal}`
      : `2 to the power ${exponent}, a ${groupDigits(digits.toString())}-digit number`;
  const title =
    decimal !== null
      ? `${power} = ${decimal}`
      : `${power} (${groupDigits(digits.toString())} digits, too long to expand)`;
  return { kind: "power", text: power, exponent, digits, ariaLabel: spoken, title };
}

export type ScoreDisplay = {
  /** Compact visible text. Exact (grouped) when short; otherwise a truncated scientific form. */
  readonly short: string;
  readonly exact: Decimal;
  readonly digits: number;
  readonly truncated: boolean;
  /** Screen-reader text: exact when short enough, otherwise the magnitude. */
  readonly spoken: string;
};

/** Scores up to this many digits render exactly with grouping. */
export const SCORE_EXACT_MAX_DIGITS = 15;

export function formatScore(score: Decimal): ScoreDisplay {
  if (!isDecimal(score)) throw new RangeError(`Invalid score: ${score}`);
  const digits = score.length;
  if (digits <= SCORE_EXACT_MAX_DIGITS) {
    return { short: groupDigits(score), exact: score, digits, truncated: false, spoken: score };
  }
  const mantissa = `${score[0]}.${score.slice(1, 6)}`;
  const power = digits - 1;
  return {
    short: `${mantissa}… × 10^${power}`,
    exact: score,
    digits,
    truncated: true,
    spoken: `about ${mantissa} times 10 to the power ${power}, a ${digits}-digit score`,
  };
}
