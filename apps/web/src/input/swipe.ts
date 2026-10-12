import type { Direction } from "@2048/contracts";

export const SWIPE_MIN_DISTANCE = 24; // CSS px
export const SWIPE_AXIS_RATIO = 1.4; // dominant axis must beat the other by this factor
export const SWIPE_MAX_DURATION_MS = 1200;

/** Classify a finished pointer gesture. Returns null for taps, slow drags and diagonal wobble. */
export function classifySwipe(dx: number, dy: number, durationMs: number, minDistance = SWIPE_MIN_DISTANCE): Direction | null {
  if (durationMs > SWIPE_MAX_DURATION_MS) return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < minDistance) return null;
  if (ax >= ay * SWIPE_AXIS_RATIO) return dx > 0 ? "right" : "left";
  if (ay >= ax * SWIPE_AXIS_RATIO) return dy > 0 ? "down" : "up";
  return null;
}
