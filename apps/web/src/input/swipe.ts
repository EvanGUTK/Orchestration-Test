import type { Direction } from "@g2048/contracts";

export type SwipeOptions = {
  /** Minimum travel along the dominant axis, in CSS px. */
  minDistance: number;
  /** Dominant axis must exceed the other by this factor, so diagonal drags are ignored. */
  dominance: number;
  /** Slower drags are treated as scroll/inspection, not a swipe. */
  maxDurationMs: number;
};

/**
 * 24px is ~1/3 of a typical fingertip contact width on phones and smaller than one tile even on an 8x8
 * board at 320px, while still rejecting taps and jitter (usually < 10px).
 */
export const DEFAULT_SWIPE: SwipeOptions = { minDistance: 24, dominance: 1.3, maxDurationMs: 1000 };

export function detectSwipe(
  dx: number,
  dy: number,
  durationMs: number,
  options: SwipeOptions = DEFAULT_SWIPE,
): Direction | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || durationMs > options.maxDurationMs) return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < options.minDistance) return null;
  if (ax >= ay * options.dominance) return dx > 0 ? "right" : "left";
  if (ay >= ax * options.dominance) return dy > 0 ? "down" : "up";
  return null;
}

/** Tracks a single pointer gesture. Multi-touch (pinch) gestures are ignored. */
export class SwipeTracker {
  private start: { id: number; x: number; y: number; t: number } | null = null;

  constructor(private readonly options: SwipeOptions = DEFAULT_SWIPE) {}

  down(id: number, x: number, y: number, t: number): void {
    this.start = this.start ? null : { id, x, y, t };
  }

  up(id: number, x: number, y: number, t: number): Direction | null {
    const s = this.start;
    this.start = null;
    if (!s || s.id !== id) return null;
    return detectSwipe(x - s.x, y - s.y, t - s.t, this.options);
  }

  cancel(): void {
    this.start = null;
  }
}
