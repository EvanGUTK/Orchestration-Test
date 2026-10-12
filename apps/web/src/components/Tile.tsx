import type { CSSProperties } from "react";
import type { Exponent } from "@g2048/contracts";
import type { TileAnimation } from "../game/animation.js";
import { tileDisplay } from "../lib/format.js";
import type { TileDisplayStyle } from "../lib/format.js";

export const TONE_COUNT = 12n;

/** Palette slot + tier for an exponent, computed with BigInt (exponents may be huge strings). */
export function tileTone(exponent: Exponent): { tone: number; tier: number } {
  const e = BigInt(exponent) - 1n;
  const tier = e / TONE_COUNT;
  // Small display indices only; the game value itself is never converted.
  return { tone: Number(e % TONE_COUNT), tier: tier > 3n ? 3 : Number(tier) };
}

type TileProps = {
  exponent: Exponent;
  style: TileDisplayStyle;
  animation?: TileAnimation | undefined;
};

/** Visible tile label: decimal, or 2 with a superscript exponent. */
export function TileText({ exponent, style }: { exponent: Exponent; style: TileDisplayStyle }) {
  const display = tileDisplay(exponent, style);
  return (
    <span title={display.title}>
      <span aria-hidden="true">
        {display.kind === "power" ? (
          <>
            2<sup>{display.exponent}</sup>
          </>
        ) : (
          display.text
        )}
      </span>
      <span className="visually-hidden">{display.ariaLabel}</span>
    </span>
  );
}

export function Tile({ exponent, style, animation }: TileProps) {
  const display = tileDisplay(exponent, style);
  const { tone, tier } = tileTone(exponent);
  // Visual length drives font scaling; superscript digits count ~0.6 of a base glyph.
  const chars = display.kind === "power" ? 1.2 + display.exponent.length * 0.72 : display.text.length;
  const css = {
    "--tone": `var(--tile-${tone})`,
    "--tone-ink": `var(--tile-${tone}-ink)`,
    "--chars": Math.max(2, chars),
    "--dx": animation?.dx ?? 0,
    "--dy": animation?.dy ?? 0,
  } as CSSProperties;
  return (
    <div
      className="tile"
      role="img"
      data-exp={exponent}
      data-kind={display.kind}
      data-tier={tier}
      data-anim={animation?.kind}
      style={css}
      aria-label={display.ariaLabel}
      title={display.title}
    >
      <span className="tile__text" aria-hidden="true">
        {display.kind === "power" ? (
          <>
            2<sup>{display.exponent}</sup>
          </>
        ) : (
          display.text
        )}
      </span>
    </div>
  );
}
