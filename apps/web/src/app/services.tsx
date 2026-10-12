import { createContext, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Announcer } from "../a11y/announcer.js";
import type { GameController, GameSnapshot } from "../game/controller.js";
import type { GuestSaveStore } from "../game/save-store.js";
import type { SoundPlayer } from "../lib/sound.js";
import type { Settings, SettingsStore } from "../settings/store.js";

/** Everything screens need, injected so tests can supply doubles (engine, storage, timers). */
export type AppServices = {
  /** Guest game (local engine adapter), or null while the engine is not integrated in this build. */
  readonly game: GameController | null;
  readonly settings: SettingsStore;
  readonly saves: GuestSaveStore;
  readonly announcer: Announcer;
  readonly sound: SoundPlayer;
};

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("ServicesProvider missing");
  return services;
}

export function useSettings(): Settings {
  const { settings } = useServices();
  return useSyncExternalStore(settings.subscribe, settings.get, settings.get);
}

const EMPTY_SNAPSHOT: GameSnapshot = {
  session: null,
  lastMove: null,
  celebrating: false,
  notice: null,
  queued: 0,
};
const noopSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;

export function useGameSnapshot(game: GameController | null): GameSnapshot {
  return useSyncExternalStore(
    game ? game.subscribe : noopSubscribe,
    game ? game.getSnapshot : emptySnapshot,
    game ? game.getSnapshot : emptySnapshot,
  );
}
