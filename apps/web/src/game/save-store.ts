import { GAME_MODES, PracticeOptionsSchema, RULESETS, practiceRuleset } from "@g2048/contracts";
import type { GameMode, Ruleset } from "@g2048/contracts";

/** Guest autosave persisted in this browser only. Account saves live on the server (FRONTEND-002). */
export type SavedGame = {
  readonly version: 1;
  readonly id: string;
  readonly mode: GameMode;
  readonly rules: Ruleset;
  readonly seed: string | null;
  /** engine.serialize(state): canonical JSON, re-validated with engine.deserialize on load. */
  readonly state: string;
  readonly savedAt: string;
  /** For replays: serialized initial state and the final-path moves as letters u/r/d/l (undo pops). */
  readonly initial?: string;
  readonly path?: string;
};

export interface GuestSaveStore {
  load(): SavedGame | null;
  save(game: SavedGame): void;
  clear(): void;
}

export const GUEST_SAVE_KEY = "g2048.guest.game.v1";

/** Returns the canonical ruleset for a stored one, or null if it is not a ruleset guests may play. */
export function canonicalGuestRules(rules: unknown): Ruleset | null {
  if (typeof rules !== "object" || rules === null) return null;
  const r = rules as Record<string, unknown>;
  if (r.version === "classic-v1") return RULESETS["classic-v1"];
  if (r.version === "practice-v1") {
    const parsed = PracticeOptionsSchema.safeParse({ size: r.size, fourWeight: r.fourWeight, undo: r.undo });
    return parsed.success ? practiceRuleset(parsed.data) : null;
  }
  return null;
}

function parseSaved(raw: string): SavedGame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.id !== "string" || typeof v.state !== "string") return null;
  if (typeof v.mode !== "string" || !(GAME_MODES as readonly string[]).includes(v.mode)) return null;
  if (v.mode !== "classic" && v.mode !== "practice") return null;
  const rules = canonicalGuestRules(v.rules);
  if (!rules) return null;
  const seed = typeof v.seed === "string" ? v.seed : null;
  const savedAt = typeof v.savedAt === "string" ? v.savedAt : "";
  const replay =
    typeof v.initial === "string" && typeof v.path === "string" && /^[urdl]*$/.test(v.path)
      ? { initial: v.initial, path: v.path }
      : {};
  return { version: 1, id: v.id, mode: v.mode, rules, seed, state: v.state, savedAt, ...replay };
}

/** localStorage-backed store; every storage failure (quota, privacy mode) degrades to "no save". */
export function createGuestSaveStore(storage: Storage | null, key = GUEST_SAVE_KEY): GuestSaveStore {
  return {
    load() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        return raw === null ? null : parseSaved(raw);
      } catch {
        return null;
      }
    },
    save(game) {
      if (!storage) return;
      try {
        storage.setItem(key, JSON.stringify(game));
      } catch {
        // Quota exceeded or storage disabled: the in-memory game continues; nothing is corrupted.
      }
    },
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

export function memorySaveStore(): GuestSaveStore & { peek(): SavedGame | null } {
  let saved: SavedGame | null = null;
  return {
    load: () => saved,
    save: (game) => {
      saved = game;
    },
    clear: () => {
      saved = null;
    },
    peek: () => saved,
  };
}
