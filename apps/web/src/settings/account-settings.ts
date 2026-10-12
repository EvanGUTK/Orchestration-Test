import type { Preferences } from "@g2048/contracts";
import type { ApiClient } from "../api/client.js";
import { describeApiError } from "../api/client.js";
import { createLocalSettingsStore, GUEST_SETTINGS_KEY, sanitizeSettings, toPreferences } from "./store.js";
import type { Settings, SettingsStore } from "./store.js";

export type SyncState =
  | { readonly kind: "local" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "error"; readonly message: string };

export function accountSettingsKey(userId: string): string {
  return `g2048.account.${userId}.preferences.v1`;
}

/**
 * Preferences per identity: the guest keeps its localStorage store; a signed-in account gets its own
 * local cache (so a shared browser never mixes guests and accounts) that is seeded from the server's
 * `preferences` on sign-in and pushed back with PATCH /profile (debounced) on every change.
 */
export class AccountSettingsStore implements SettingsStore {
  private active: SettingsStore;
  private userId: string | null = null;
  private unsubscribeActive: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly syncListeners = new Set<() => void>();
  private sync: SyncState = { kind: "local" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushing: Promise<void> | null = null;

  constructor(
    private readonly storage: Storage | null,
    private readonly api: ApiClient,
    private readonly debounceMs = 400,
  ) {
    this.active = createLocalSettingsStore(storage, GUEST_SETTINGS_KEY);
    this.unsubscribeActive = this.active.subscribe(() => this.emit());
  }

  get = (): Settings => this.active.get();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSync = (): SyncState => this.sync;

  subscribeSync = (listener: () => void) => {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  private setSync(state: SyncState) {
    this.sync = state;
    for (const l of this.syncListeners) l();
  }

  /** Switches identity. Server preferences (possibly partial) override the account's local cache. */
  useIdentity(userId: string | null, serverPreferences?: Preferences): void {
    if (userId === this.userId && !serverPreferences) return;
    this.cancelPending();
    this.unsubscribeActive();
    this.userId = userId;
    this.active = createLocalSettingsStore(
      this.storage,
      userId ? accountSettingsKey(userId) : GUEST_SETTINGS_KEY,
    );
    if (userId && serverPreferences && Object.keys(serverPreferences).length > 0) {
      this.active.update(sanitizeSettings({ ...toPreferences(this.active.get()), ...serverPreferences }));
    }
    this.unsubscribeActive = this.active.subscribe(() => this.emit());
    this.setSync({ kind: userId ? "saved" : "local" });
    this.emit();
  }

  update(patch: Partial<Settings>): void {
    this.active.update(patch);
    this.schedulePush();
  }

  reset(): void {
    this.active.reset();
    this.schedulePush();
  }

  /** Sends pending changes now (also used by "Retry" and tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.push();
    } else if (this.pushing) {
      await this.pushing;
    }
  }

  async retry(): Promise<void> {
    if (this.userId) await this.push();
  }

  private cancelPending() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedulePush() {
    if (!this.userId) return;
    this.cancelPending();
    this.setSync({ kind: "saving" });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push();
    }, this.debounceMs);
  }

  private push(): Promise<void> {
    const userId = this.userId;
    if (!userId) return Promise.resolve();
    const preferences = toPreferences(this.active.get());
    this.setSync({ kind: "saving" });
    const run = this.api
      .patchProfile({ preferences })
      .then(() => {
        if (this.userId === userId) this.setSync({ kind: "saved" });
      })
      .catch((error: unknown) => {
        if (this.userId === userId) {
          this.setSync({
            kind: "error",
            message: `Saved in this browser only: ${describeApiError(error)}`,
          });
        }
      })
      .finally(() => {
        if (this.pushing === run) this.pushing = null;
      });
    this.pushing = run;
    return run;
  }
}
