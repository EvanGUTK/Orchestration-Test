import { DIRECTIONS } from "@g2048/contracts";
import type { Direction } from "@g2048/contracts";

export type KeyBindings = Readonly<Record<Direction, readonly string[]>>;

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  up: ["ArrowUp", "w"],
  right: ["ArrowRight", "d"],
  down: ["ArrowDown", "s"],
  left: ["ArrowLeft", "a"],
};

/** Single printable characters compare case-insensitively ("W" with Shift/Caps Lock is still "w"). */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export type KeyLike = {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
};

/** Returns the bound direction, or null. Modified keys (Ctrl/Alt/Meta) never move, so shortcuts keep working. */
export function directionForKey(
  event: KeyLike,
  bindings: KeyBindings = DEFAULT_KEY_BINDINGS,
): Direction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const key = normalizeKey(event.key);
  for (const direction of DIRECTIONS) {
    if (bindings[direction].some((bound) => normalizeKey(bound) === key)) return direction;
  }
  return null;
}

/** Human-readable key name for settings and help text. */
export function describeKey(key: string): string {
  const names: Record<string, string> = {
    ArrowUp: "↑",
    ArrowRight: "→",
    ArrowDown: "↓",
    ArrowLeft: "←",
    " ": "Space",
  };
  return names[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** Keys that may never be bound (they are needed for navigation and dialogs). */
export const RESERVED_KEYS = new Set(["Tab", "Escape", "Enter", " "]);
