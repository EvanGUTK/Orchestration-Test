import { Announcer } from "../a11y/announcer.js";
import type { AnnouncerOptions } from "../a11y/announcer.js";
import { GameController } from "../game/controller.js";
import type { EnginePort } from "../game/engine-port.js";
import { createLocalAdapter } from "../game/local-adapter.js";
import { createGuestSaveStore } from "../game/save-store.js";
import type { GuestSaveStore } from "../game/save-store.js";
import { createSoundPlayer } from "../lib/sound.js";
import type { SoundPlayer } from "../lib/sound.js";
import { createLocalSettingsStore } from "../settings/store.js";
import type { SettingsStore } from "../settings/store.js";
import type { AppServices } from "./services.js";

export type ServiceOptions = {
  engine: EnginePort | null;
  storage: Storage | null;
  settings?: SettingsStore;
  saves?: GuestSaveStore;
  sound?: SoundPlayer;
  announcer?: AnnouncerOptions;
};

export function createAppServices(options: ServiceOptions): AppServices {
  const settings = options.settings ?? createLocalSettingsStore(options.storage);
  const saves = options.saves ?? createGuestSaveStore(options.storage);
  const announcer = new Announcer(options.announcer);
  const sound = options.sound ?? createSoundPlayer(() => settings.get().soundMuted);
  const game = options.engine
    ? new GameController(createLocalAdapter(options.engine, saves), { announcer, sound })
    : null;
  return { game, settings, saves, announcer, sound };
}

export function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
