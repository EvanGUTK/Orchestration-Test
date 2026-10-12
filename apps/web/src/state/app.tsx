import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Identity, LoginRequest, Preferences, RegisterRequest } from "@2048/contracts";
import { ApiClient, isApiError } from "../api/client.ts";
import { api as defaultApi } from "../api/client.ts";
import { DEFAULT_PREFERENCES, applyPreferencesToDocument, loadGuestPreferences, normalisePreferences, saveGuestPreferences } from "./prefs.ts";

export type ServerStatus = "checking" | "online" | "offline";

export type AppContextValue = {
  api: ApiClient;
  /** Server identity (registered user or server guest). null => offline, local-only guest. */
  identity: Identity | null;
  isUser: boolean;
  serverStatus: ServerStatus;
  prefs: Preferences;
  updatePrefs(patch: Partial<Preferences>): Promise<void>;
  signIn(request: LoginRequest): Promise<void>;
  register(request: RegisterRequest): Promise<void>;
  signOut(): Promise<void>;
  refreshIdentity(): Promise<void>;
  setIdentity(identity: Identity | null): void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <AppProvider>");
  return value;
}

export function AppProvider(props: { children: ReactNode; client?: ApiClient; initialIdentity?: Identity | null; skipBootstrap?: boolean }) {
  const client = props.client ?? defaultApi;
  const [identity, setIdentityState] = useState<Identity | null>(props.initialIdentity ?? null);
  const [serverStatus, setServerStatus] = useState<ServerStatus>(props.skipBootstrap ? "offline" : "checking");
  const [prefs, setPrefs] = useState<Preferences>(() => (props.initialIdentity ? props.initialIdentity.preferences : loadGuestPreferences()));
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    applyPreferencesToDocument(prefs);
  }, [prefs]);

  const adopt = useCallback((next: Identity | null) => {
    setIdentityState(next);
    // Preferences live on the account for registered users; guests keep them in this browser.
    setPrefs(next && next.kind === "user" ? normalisePreferences(next.preferences) : loadGuestPreferences());
  }, []);

  /** Resolve who we are: existing session, else a server guest, else offline local play. */
  const refreshIdentity = useCallback(async () => {
    try {
      adopt(await client.me());
      setServerStatus("online");
      return;
    } catch (error) {
      if (isApiError(error) && error.isNetwork) {
        setServerStatus("offline");
        adopt(null);
        return;
      }
    }
    try {
      adopt(await client.guest());
      setServerStatus("online");
    } catch (error) {
      setServerStatus(isApiError(error) && !error.isNetwork ? "online" : "offline");
      adopt(null);
    }
  }, [client, adopt]);

  useEffect(() => {
    if (props.skipBootstrap) return;
    void refreshIdentity();
  }, [refreshIdentity, props.skipBootstrap]);

  const updatePrefs = useCallback(
    async (patch: Partial<Preferences>) => {
      const next = normalisePreferences({ ...prefs, ...patch });
      setPrefs(next);
      if (identityRef.current?.kind === "user") {
        try {
          const updated = await client.patchProfile({ preferences: patch });
          setIdentityState((current) => (current ? { ...current, preferences: normalisePreferences(updated.preferences) } : current));
        } catch {
          /* keep the optimistic local value; the settings screen reports save failures itself */
          throw new Error("Could not save preferences to your account. They apply to this tab only.");
        }
      } else {
        saveGuestPreferences(next);
      }
    },
    [client, prefs],
  );

  const signIn = useCallback(
    async (request: LoginRequest) => {
      const me = await client.login(request);
      setServerStatus("online");
      adopt(me);
    },
    [client, adopt],
  );
  const register = useCallback(
    async (request: RegisterRequest) => {
      const me = await client.register(request);
      setServerStatus("online");
      adopt(me);
    },
    [client, adopt],
  );
  const signOut = useCallback(async () => {
    try {
      await client.logout();
    } catch (error) {
      if (!(isApiError(error) && error.code === "UNAUTHENTICATED")) throw error;
    } finally {
      await refreshIdentity();
    }
  }, [client, refreshIdentity]);

  const value = useMemo<AppContextValue>(
    () => ({ api: client, identity, isUser: identity?.kind === "user", serverStatus, prefs, updatePrefs, signIn, register, signOut, refreshIdentity, setIdentity: adopt }),
    [client, identity, serverStatus, prefs, updatePrefs, signIn, register, signOut, refreshIdentity, adopt],
  );
  return <AppContext.Provider value={value}>{props.children}</AppContext.Provider>;
}

export { DEFAULT_PREFERENCES };
