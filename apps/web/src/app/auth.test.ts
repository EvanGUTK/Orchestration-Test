import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client.js";
import { codePointLength, normalizeUsername, validateRegistration } from "../lib/validation.js";
import { loginErrorMessage } from "../screens/WelcomeScreen.js";
import { AccountSettingsStore, accountSettingsKey } from "../settings/account-settings.js";
import { GUEST_SETTINGS_KEY } from "../settings/store.js";
import { memoryStorage } from "../test/fake-engine.js";
import { createFakeServer } from "../test/fake-server.js";
import { AuthStore } from "./auth.js";

describe("registration validation (contract limits)", () => {
  it("normalizes ASCII-only to lowercase and enforces the username pattern", () => {
    expect(normalizeUsername("Ada_99")).toBe("ada_99");
    expect(normalizeUsername("ÄDA")).toBe("Äda");
    const base = { displayName: "Ada", password: "twelve chars!", confirm: "twelve chars!" };
    expect(validateRegistration({ ...base, username: "Ada_99" })).toEqual({});
    expect(validateRegistration({ ...base, username: "ab" }).username).toMatch(/3–24/);
    expect(validateRegistration({ ...base, username: "ada-lovelace" }).username).toBeDefined();
    expect(validateRegistration({ ...base, username: "a".repeat(25) }).username).toBeDefined();
  });

  it("counts display names and passwords in Unicode code points", () => {
    const emoji = "😀".repeat(48); // 96 UTF-16 units, 48 code points
    expect(codePointLength(emoji)).toBe(48);
    const ok = { username: "ada", password: "123456789012", confirm: "123456789012" };
    expect(validateRegistration({ ...ok, displayName: emoji })).toEqual({});
    expect(validateRegistration({ ...ok, displayName: `${emoji}😀` }).displayName).toMatch(/48/);
    expect(validateRegistration({ ...ok, displayName: "" }).displayName).toBeDefined();
    const pw = "🔑".repeat(11);
    expect(
      validateRegistration({ username: "ada", displayName: "A", password: pw, confirm: pw }).password,
    ).toMatch(/12/);
    expect(validateRegistration({ ...ok, displayName: "A", confirm: "different" }).confirm).toBeDefined();
  });
});

describe("AuthStore", () => {
  it("starts as guest, signs in, signs out", async () => {
    const server = createFakeServer();
    const auth = new AuthStore(new ApiClient({ fetch: server.fetch }));
    expect((await auth.refresh()).status).toBe("guest");
    await auth.login("ada", "correct horse battery");
    const state = auth.get();
    expect(state.status === "signed-in" && state.user.displayName).toBe("Ada");
    expect(await auth.logout(true)).toBe(3);
    expect(server.requests.find((r) => r.path === "/auth/logout")!.body).toEqual({ allSessions: true });
    expect(auth.get().status).toBe("guest");
  });

  it("reports offline when the server cannot be reached", async () => {
    const auth = new AuthStore(new ApiClient({ fetch: () => Promise.reject(new TypeError("down")) }));
    const state = await auth.refresh();
    expect(state.status).toBe("offline");
  });

  it("shows a generic login failure that never reveals whether the username exists", async () => {
    const server = createFakeServer();
    const auth = new AuthStore(new ApiClient({ fetch: server.fetch }));
    await auth.refresh();
    const wrong = await auth.login("nobody", "whatever").catch((e: unknown) => e);
    expect(loginErrorMessage(wrong)).toBe("Username or password is incorrect.");
    server.faults.rateLimitSeconds = 60;
    const limited = await auth.login("ada", "x").catch((e: unknown) => e);
    expect(loginErrorMessage(limited)).toBe("Too many sign-in attempts. Try again in 60 seconds.");
  });

  it("changes the password and reports revoked sessions", async () => {
    const server = createFakeServer();
    const auth = new AuthStore(new ApiClient({ fetch: server.fetch }));
    await auth.login("ada", "correct horse battery");
    expect(await auth.changePassword("correct horse battery", "a brand new passphrase")).toBe(2);
    expect(server.password).toBe("a brand new passphrase");
  });
});

describe("account preference sync", () => {
  it("keeps guest and account preferences separate and syncs account changes with PATCH /profile", async () => {
    const server = createFakeServer();
    const api = new ApiClient({ fetch: server.fetch });
    const storage = memoryStorage();
    const store = new AccountSettingsStore(storage, api, 0);
    store.update({ theme: "light" }); // guest choice
    expect(storage.getItem(GUEST_SETTINGS_KEY)).toContain('"theme":"light"');
    expect(server.requests.filter((r) => r.path === "/profile")).toHaveLength(0);

    await api.login({ username: "ada", password: "correct horse battery" });
    store.useIdentity("u1", { theme: "dark", keyBindings: { up: ["k"] } }); // partial record (C8)
    expect(store.get().theme).toBe("dark");
    expect(store.get().keyBindings.up).toEqual(["k"]);
    expect(store.get().keyBindings.left).toEqual(["ArrowLeft", "a"]);

    store.update({ motion: "reduced" });
    expect(store.getSync().kind).toBe("saving");
    await store.flush();
    expect(store.getSync().kind).toBe("saved");
    expect(server.preferences.motion).toBe("reduced");
    expect(storage.getItem(accountSettingsKey("u1"))).toContain('"motion":"reduced"');

    store.useIdentity(null);
    expect(store.get().theme).toBe("light");
    expect(store.get().motion).toBe("system");
  });

  it("keeps the change locally and reports a sync error when the server rejects it", async () => {
    const server = createFakeServer();
    const api = new ApiClient({ fetch: server.fetch });
    const store = new AccountSettingsStore(memoryStorage(), api, 0);
    store.useIdentity("u1", {});
    store.update({ soundMuted: true }); // server has no signed-in user -> 401
    await store.flush();
    const sync = store.getSync();
    expect(sync.kind).toBe("error");
    expect(store.get().soundMuted).toBe(true);
  });
});
