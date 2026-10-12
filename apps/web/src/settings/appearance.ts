import type { Settings } from "./store.js";

export type ResolvedTheme = "light" | "dark" | "high-contrast";

export type MediaPrefs = { dark: boolean; moreContrast: boolean; reducedMotion: boolean };

export function readMediaPrefs(win: Window | undefined = globalThis.window): MediaPrefs {
  const mq = (q: string) => (win && typeof win.matchMedia === "function" ? win.matchMedia(q).matches : false);
  return {
    dark: mq("(prefers-color-scheme: dark)"),
    moreContrast: mq("(prefers-contrast: more)") || mq("(forced-colors: active)"),
    reducedMotion: mq("(prefers-reduced-motion: reduce)"),
  };
}

export function resolveTheme(theme: Settings["theme"], media: MediaPrefs): ResolvedTheme {
  if (theme !== "system") return theme;
  if (media.moreContrast) return "high-contrast";
  return media.dark ? "dark" : "light";
}

export function resolveReducedMotion(motion: Settings["motion"], media: MediaPrefs): boolean {
  return motion === "system" ? media.reducedMotion : motion === "reduced";
}

/** Writes the resolved appearance to <html> data attributes consumed by tokens.css. */
export function applyAppearance(root: HTMLElement, settings: Settings, media: MediaPrefs): void {
  const theme = resolveTheme(settings.theme, media);
  root.dataset.theme = theme;
  root.dataset.motion = resolveReducedMotion(settings.motion, media) ? "reduced" : "full";
  root.style.colorScheme = theme === "light" ? "light" : "dark";
}
