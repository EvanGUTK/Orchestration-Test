import { createContext, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Announcer } from "../a11y/announcer.js";
import type { ApiClient, ConnectionState } from "../api/client.js";
import type { GameController, GameSnapshot } from "../game/controller.js";
import type { ServerGameAdapter } from "../game/server-adapter.js";
import type { GuestSaveStore } from "../game/save-store.js";
import type { SoundPlayer } from "../lib/sound.js";
import type { AccountSettingsStore, SyncState } from "../settings/account-settings.js";
import type { Settings } from "../settings/store.js";
import type { AuthState, AuthStore } from "./auth.js";

/** Everything screens need, injected so tests can supply doubles (engine, fetch, storage, timers). */
export type AppServices = {
  readonly api: ApiClient;
  readonly auth: AuthStore;
  /** Guest game (local engine, works offline), or null if no engine is available in this build. */
  readonly localGame: GameController | null;
  /** Account game, authoritative on the local server. */
  readonly serverGame: GameController;
  readonly serverAdapter: ServerGameAdapter;
  readonly settings: AccountSettingsStore;
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

export function useSettingsSync(): SyncState {
  const { settings } = useServices();
  return useSyncExternalStore(settings.subscribeSync, settings.getSync, settings.getSync);
}

export function useAuth(): AuthState {
  const { auth } = useServices();
  return useSyncExternalStore(auth.subscribe, auth.get, auth.get);
}

export function useConnection(): ConnectionState {
  const { api } = useServices();
  return useSyncExternalStore(api.connection.subscribe, api.connection.get, api.connection.get);
}

/** Signed-in players use the server game; guests (and offline) use the local engine. */
export function useActiveGame(): GameController | null {
  const services = useServices();
  const auth = useAuth();
  return auth.status === "signed-in" ? services.serverGame : services.localGame;
}

const EMPTY_SNAPSHOT: GameSnapshot = {
  session: null,
  lastMove: null,
  celebrating: false,
  notice: null,
  queued: 0,
  errorCode: null,
  stalled: null,
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
