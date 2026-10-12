import type { GameState, Ruleset } from "@2048/contracts";
import { resolveRules } from "@2048/contracts";
import { getEngine } from "../engine/port.ts";

const SAVE_KEY = "2048-infinite:guest-game:v1";

export type GuestSave = { seed: string; mode: "classic" | "practice"; updatedAt: string; state: GameState; rules: Ruleset };

type Stored = { seed: string; mode: "classic" | "practice"; updatedAt: string; state: string };

export function saveGuestGame(save: GuestSave, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    const stored: Stored = { seed: save.seed, mode: save.mode, updatedAt: save.updatedAt, state: getEngine().serialize(save.state) };
    storage.setItem(SAVE_KEY, JSON.stringify(stored));
  } catch {
    /* quota or private mode: the live game keeps working, it just cannot be resumed after a reload */
  }
}

export function loadGuestGame(storage: Pick<Storage, "getItem"> = localStorage): GuestSave | null {
  try {
    const text = storage.getItem(SAVE_KEY);
    if (!text) return null;
    const stored = JSON.parse(text) as Stored;
    const state = getEngine().deserialize(stored.state);
    const rules = resolveRules(state.rulesetVersion);
    if (!rules || rules.official) return null;
    return { seed: stored.seed, mode: stored.mode, updatedAt: stored.updatedAt, state, rules };
  } catch {
    return null;
  }
}

export function clearGuestGame(storage: Pick<Storage, "removeItem"> = localStorage): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}
