import { Announcer } from "../a11y/announcer.js";
import type { AnnouncerOptions } from "../a11y/announcer.js";
import { ApiClient } from "../api/client.js";
import type { ApiClientOptions, Sleep } from "../api/client.js";
import { GameController } from "../game/controller.js";
import type { EnginePort } from "../game/engine-port.js";
import { createLocalAdapter } from "../game/local-adapter.js";
import { createGuestSaveStore } from "../game/save-store.js";
import type { GuestSaveStore } from "../game/save-store.js";
import { ServerGameAdapter } from "../game/server-adapter.js";
import { createSoundPlayer } from "../lib/sound.js";
import type { SoundPlayer } from "../lib/sound.js";
import { AccountSettingsStore } from "../settings/account-settings.js";
import { AuthStore } from "./auth.js";
import type { AppServices } from "./services.js";

export type ServiceOptions = {
  engine: EnginePort | null;
  storage: Storage | null;
  /** Injected fetch (tests use a mock). Defaults to the browser fetch. */
  fetch?: ApiClientOptions["fetch"];
  saves?: GuestSaveStore;
  sound?: SoundPlayer;
  announcer?: AnnouncerOptions;
  /** Backoff sleep for retries (tests pass an instant one). */
  sleep?: Sleep;
  retryDelays?: readonly number[];
  settingsDebounceMs?: number;
};

export function createAppServices(options: ServiceOptions): AppServices {
  const api = new ApiClient({ fetch: options.fetch });
  const auth = new AuthStore(api);
  const settings = new AccountSettingsStore(options.storage, api, options.settingsDebounceMs);
  const saves = options.saves ?? createGuestSaveStore(options.storage);
  const announcer = new Announcer(options.announcer);
  const sound = options.sound ?? createSoundPlayer(() => settings.get().soundMuted);
  const localGame = options.engine
    ? new GameController(createLocalAdapter(options.engine, saves), { announcer, sound })
    : null;
  const serverAdapter = new ServerGameAdapter(api, {
    sleep: options.sleep,
    delays: options.retryDelays,
    onUnauthenticated: () => auth.sessionExpired(),
  });
  const serverGame = new GameController(serverAdapter, { announcer, sound });

  // Identity changes switch preference sets and detach the previous account's game.
  let lastUser: string | null = null;
  auth.subscribe(() => {
    const state = auth.get();
    const userId = state.status === "signed-in" ? state.user.id : null;
    if (userId !== lastUser) {
      if (lastUser !== null) void serverGame.discard();
      lastUser = userId;
      settings.useIdentity(userId, state.status === "signed-in" ? state.me.preferences : undefined);
    }
  });

  return { api, auth, localGame, serverGame, serverAdapter, settings, saves, announcer, sound };
}

export function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
