import type { MeResponse, PublicUser } from "@g2048/contracts";
import type { ApiClient } from "../api/client.js";
import { describeApiError } from "../api/client.js";

export type AuthState =
  | { readonly status: "loading" }
  /** The local server could not be reached: guest play continues offline in this browser. */
  | { readonly status: "offline"; readonly message: string }
  | { readonly status: "guest"; readonly me: MeResponse }
  | { readonly status: "signed-in"; readonly me: MeResponse; readonly user: PublicUser };

/**
 * Identity as reported by GET /auth/me. Cookies are HttpOnly; after every identity change (login,
 * register, logout, password change) the client re-reads /auth/me for the user and the rotated CSRF token.
 */
export class AuthStore {
  private state: AuthState = { status: "loading" };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: ApiClient) {}

  get = (): AuthState => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(state: AuthState) {
    this.state = state;
    for (const l of this.listeners) l();
  }

  private adoptMe(me: MeResponse) {
    this.set(me.user ? { status: "signed-in", me, user: me.user } : { status: "guest", me });
  }

  async refresh(): Promise<AuthState> {
    try {
      this.adoptMe(await this.api.me());
    } catch (error) {
      this.set({ status: "offline", message: describeApiError(error) });
    }
    return this.state;
  }

  private async afterIdentityChange(): Promise<void> {
    this.api.resetSession();
    await this.refresh();
  }

  async login(username: string, password: string): Promise<void> {
    this.adoptMe(await this.api.login({ username, password }));
  }

  async register(username: string, displayName: string, password: string): Promise<void> {
    this.adoptMe(await this.api.register({ username, displayName, password }));
  }

  /** Signs out this browser, or every session of the account with `allSessions`. */
  async logout(allSessions = false): Promise<number | null> {
    try {
      const res = await this.api.logout(allSessions);
      return typeof res?.revokedSessions === "number" ? res.revokedSessions : null;
    } finally {
      await this.afterIdentityChange();
    }
  }

  /** Changes the password; the server revokes the account's other sessions. Returns how many. */
  async changePassword(currentPassword: string, newPassword: string): Promise<number | null> {
    const res = await this.api.changePassword({ currentPassword, newPassword });
    await this.afterIdentityChange();
    return typeof res?.revokedSessions === "number" ? res.revokedSessions : null;
  }

  async updateDisplayName(displayName: string): Promise<void> {
    await this.api.patchProfile({ displayName });
    await this.refresh();
  }

  /** A request elsewhere returned 401: the session expired or was revoked. */
  sessionExpired(): void {
    if (this.state.status === "signed-in") void this.afterIdentityChange();
  }
}
