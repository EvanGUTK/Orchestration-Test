import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../test/fake-engine.js";
import { applyAppearance, resolveReducedMotion, resolveTheme } from "./appearance.js";
import { createLocalSettingsStore, DEFAULT_SETTINGS, GUEST_SETTINGS_KEY, sanitizeSettings } from "./store.js";

const noMedia = { dark: false, moreContrast: false, reducedMotion: false };

describe("settings store", () => {
  it("persists guest preferences and notifies subscribers", () => {
    const storage = memoryStorage();
    const store = createLocalSettingsStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ theme: "dark", soundMuted: true, botSpeedMs: 1200 });
    expect(listener).toHaveBeenCalledTimes(1);
    const reloaded = createLocalSettingsStore(storage).get();
    expect(reloaded).toMatchObject({ theme: "dark", soundMuted: true, botSpeedMs: 1200 });
  });

  it("falls back per field when stored data is invalid or tampered", () => {
    const s = sanitizeSettings({
      theme: "neon",
      motion: "reduced",
      botSpeedMs: 999999,
      keyBindings: { up: ["Tab"] },
    });
    expect(s.theme).toBe("system");
    expect(s.motion).toBe("reduced");
    expect(s.botSpeedMs).toBe(DEFAULT_SETTINGS.botSpeedMs);
    expect(s.keyBindings.up).toEqual(["ArrowUp", "w"]); // reserved key rejected -> default
  });

  it("survives corrupt JSON and unavailable storage", () => {
    const storage = memoryStorage();
    storage.setItem(GUEST_SETTINGS_KEY, "{not json");
    expect(createLocalSettingsStore(storage).get()).toEqual(DEFAULT_SETTINGS);
    const store = createLocalSettingsStore(null);
    store.update({ theme: "light" });
    expect(store.get().theme).toBe("light");
  });
});

describe("theme switching", () => {
  it("resolves system theme from media preferences", () => {
    expect(resolveTheme("system", noMedia)).toBe("light");
    expect(resolveTheme("system", { ...noMedia, dark: true })).toBe("dark");
    expect(resolveTheme("system", { ...noMedia, dark: true, moreContrast: true })).toBe("high-contrast");
    expect(resolveTheme("light", { ...noMedia, dark: true })).toBe("light");
  });

  it("resolves motion: explicit setting wins over the OS", () => {
    expect(resolveReducedMotion("system", { ...noMedia, reducedMotion: true })).toBe(true);
    expect(resolveReducedMotion("full", { ...noMedia, reducedMotion: true })).toBe(false);
    expect(resolveReducedMotion("reduced", noMedia)).toBe(true);
  });

  it("writes data-theme and data-motion to the root element", () => {
    const root = document.createElement("html");
    applyAppearance(root, { ...DEFAULT_SETTINGS, theme: "high-contrast", motion: "reduced" }, noMedia);
    expect(root.dataset.theme).toBe("high-contrast");
    expect(root.dataset.motion).toBe("reduced");
    applyAppearance(root, { ...DEFAULT_SETTINGS, theme: "dark" }, noMedia);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.motion).toBe("full");
  });
});
