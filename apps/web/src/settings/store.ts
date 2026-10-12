import { DIRECTIONS, PreferencesSchema } from "@g2048/contracts";
import type { Direction, Preferences } from "@g2048/contracts";
import { DEFAULT_KEY_BINDINGS, RESERVED_KEYS } from "../input/keyboard.js";
import type { KeyBindings } from "../input/keyboard.js";

export type Settings = {
  readonly theme: NonNullable<Preferences["theme"]>;
  readonly soundMuted: boolean;
  readonly motion: NonNullable<Preferences["motion"]>;
  readonly tileDisplay: NonNullable<Preferences["tileDisplay"]>;
  readonly keyBindings: KeyBindings;
  readonly botSpeedMs: number;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  soundMuted: false,
  motion: "system",
  tileDisplay: "auto",
  keyBindings: DEFAULT_KEY_BINDINGS,
  botSpeedMs: 400,
};

/**
 * Preference store. FRONTEND-001 persists the guest's preferences in localStorage; a later task syncs
 * the same shape (contracts `Preferences`) with PATCH /profile for signed-in accounts by providing
 * another implementation of this interface.
 */
export interface SettingsStore {
  get(): Settings;
  update(patch: Partial<Settings>): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export const GUEST_SETTINGS_KEY = "g2048.guest.preferences.v1";

function sanitizeBindings(value: unknown): KeyBindings {
  const out: Record<Direction, string[]> = { up: [], right: [], down: [], left: [] };
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  for (const d of DIRECTIONS) {
    const keys = raw[d];
    out[d] = Array.isArray(keys)
      ? keys
          .filter(
            (k): k is string =>
              typeof k === "string" && k.length > 0 && k.length <= 32 && !RESERVED_KEYS.has(k),
          )
          .slice(0, 4)
      : [];
    if (out[d].length === 0) out[d] = [...DEFAULT_KEY_BINDINGS[d]];
  }
  return out;
}

/** Field-by-field validation against the contract schema; invalid fields fall back to defaults. */
export function sanitizeSettings(raw: unknown): Settings {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const shape = PreferencesSchema.shape;
  const pick = <K extends "theme" | "soundMuted" | "motion" | "tileDisplay" | "botSpeedMs">(
    key: K,
  ): Settings[K] => {
    const parsed = shape[key].safeParse(source[key]);
    return (parsed.success && parsed.data !== undefined ? parsed.data : DEFAULT_SETTINGS[key]) as Settings[K];
  };
  return {
    theme: pick("theme"),
    soundMuted: pick("soundMuted"),
    motion: pick("motion"),
    tileDisplay: pick("tileDisplay"),
    botSpeedMs: pick("botSpeedMs"),
    keyBindings: sanitizeBindings(source.keyBindings),
  };
}

/** Contract `Preferences` payload for export / future server sync. */
export function toPreferences(settings: Settings): Preferences {
  return {
    theme: settings.theme,
    soundMuted: settings.soundMuted,
    motion: settings.motion,
    tileDisplay: settings.tileDisplay,
    botSpeedMs: settings.botSpeedMs,
    keyBindings: {
      up: [...settings.keyBindings.up],
      right: [...settings.keyBindings.right],
      down: [...settings.keyBindings.down],
      left: [...settings.keyBindings.left],
    },
  };
}

export function createLocalSettingsStore(storage: Storage | null, key = GUEST_SETTINGS_KEY): SettingsStore {
  const listeners = new Set<() => void>();
  let current: Settings = DEFAULT_SETTINGS;
  try {
    const raw = storage?.getItem(key);
    if (raw) current = sanitizeSettings(JSON.parse(raw));
  } catch {
    current = DEFAULT_SETTINGS;
  }

  const commit = (next: Settings) => {
    current = next;
    try {
      storage?.setItem(key, JSON.stringify(toPreferences(next)));
    } catch {
      // Storage unavailable: settings still apply for this session.
    }
    for (const l of listeners) l();
  };

  return {
    get: () => current,
    update: (patch) => commit(sanitizeSettings({ ...toPreferences(current), ...patch })),
    reset: () => commit(DEFAULT_SETTINGS),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
