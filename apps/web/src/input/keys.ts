import type { Direction, Preferences } from "@2048/contracts";
import { DIRECTIONS } from "@2048/contracts";

export type KeyBindings = Preferences["keyBindings"];

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  up: ["ArrowUp", "w"],
  right: ["ArrowRight", "d"],
  down: ["ArrowDown", "s"],
  left: ["ArrowLeft", "a"],
};

function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Map a KeyboardEvent-like object to a direction, or null. Modified keys (ctrl/alt/meta) are never game keys. */
export function directionForKey(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  bindings: KeyBindings = DEFAULT_KEY_BINDINGS,
): Direction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = normaliseKey(event.key);
  for (const direction of DIRECTIONS) {
    if (bindings[direction].some((binding) => normaliseKey(binding) === key)) return direction;
  }
  return null;
}

/** Sanitise bindings loaded from storage or the server; fall back per-direction to defaults. */
export function sanitiseBindings(value: unknown): KeyBindings {
  const out: KeyBindings = { ...DEFAULT_KEY_BINDINGS };
  if (typeof value !== "object" || value === null) return out;
  for (const direction of DIRECTIONS) {
    const raw = (value as Record<string, unknown>)[direction];
    if (Array.isArray(raw)) {
      const keys = raw.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 20).slice(0, 4);
      if (keys.length > 0) out[direction] = keys;
    }
  }
  return out;
}

export function parseBindingText(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 4);
}
