import type { Preferences } from "@2048/contracts";
import { DEFAULT_KEY_BINDINGS, sanitiseBindings } from "../input/keys.ts";

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  soundMuted: false,
  motion: "system",
  tileStyle: "numbers-pattern",
  keyBindings: DEFAULT_KEY_BINDINGS,
  botSpeed: "normal",
};

const THEMES: Preferences["theme"][] = ["light", "dark", "high-contrast", "system"];
const MOTIONS: Preferences["motion"][] = ["full", "reduced", "system"];
const TILE_STYLES: Preferences["tileStyle"][] = ["numbers", "powers", "numbers-pattern"];
const SPEEDS: Preferences["botSpeed"][] = ["slow", "normal", "fast"];

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function normalisePreferences(value: unknown): Preferences {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    theme: pick(THEMES, raw["theme"], DEFAULT_PREFERENCES.theme),
    soundMuted: typeof raw["soundMuted"] === "boolean" ? raw["soundMuted"] : DEFAULT_PREFERENCES.soundMuted,
    motion: pick(MOTIONS, raw["motion"], DEFAULT_PREFERENCES.motion),
    tileStyle: pick(TILE_STYLES, raw["tileStyle"], DEFAULT_PREFERENCES.tileStyle),
    keyBindings: sanitiseBindings(raw["keyBindings"]),
    botSpeed: pick(SPEEDS, raw["botSpeed"], DEFAULT_PREFERENCES.botSpeed),
  };
}

const GUEST_KEY = "2048-infinite:guest-preferences:v1";

export function loadGuestPreferences(storage: Pick<Storage, "getItem"> = localStorage): Preferences {
  try {
    const text = storage.getItem(GUEST_KEY);
    return text ? normalisePreferences(JSON.parse(text)) : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveGuestPreferences(prefs: Preferences, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(GUEST_KEY, JSON.stringify(prefs));
  } catch {
    /* storage may be unavailable (private mode); preferences then last for this tab only */
  }
}

/** Applies theme/motion preferences to the document root. CSS reads these attributes. */
export function applyPreferencesToDocument(prefs: Preferences, root: HTMLElement = document.documentElement): void {
  root.dataset["theme"] = prefs.theme;
  root.dataset["motion"] = prefs.motion;
  root.dataset["tiles"] = prefs.tileStyle;
}
