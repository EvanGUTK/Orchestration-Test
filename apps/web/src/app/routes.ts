import { useSyncExternalStore } from "react";

export type RouteId =
  | "welcome"
  | "modes"
  | "play"
  | "practice"
  | "saves"
  | "challenges"
  | "leaderboards"
  | "profile"
  | "lobby"
  | "duel"
  | "bots"
  | "replays"
  | "settings"
  | "data";

export type RouteGroup = "Play" | "Compete" | "You";

export type RouteDef = {
  readonly id: RouteId;
  readonly path: string;
  readonly title: string;
  readonly nav: string;
  readonly group: RouteGroup;
};

export const ROUTES: readonly RouteDef[] = [
  { id: "welcome", path: "/", title: "Welcome", nav: "Welcome", group: "Play" },
  { id: "modes", path: "/modes", title: "Choose a mode", nav: "Modes", group: "Play" },
  { id: "play", path: "/play", title: "Solo board", nav: "Solo board", group: "Play" },
  { id: "practice", path: "/practice", title: "Custom practice", nav: "Custom practice", group: "Play" },
  { id: "saves", path: "/saves", title: "Saved games", nav: "Save / resume", group: "Play" },
  { id: "challenges", path: "/challenges", title: "Ranked challenges", nav: "Challenges", group: "Compete" },
  { id: "leaderboards", path: "/leaderboards", title: "Leaderboards", nav: "Leaderboards", group: "Compete" },
  { id: "lobby", path: "/duel", title: "Duel lobby", nav: "Duel lobby", group: "Compete" },
  { id: "duel", path: "/duel/match", title: "Split-board duel", nav: "Split duel", group: "Compete" },
  { id: "bots", path: "/bots", title: "Bot laboratory", nav: "Bot lab", group: "Compete" },
  { id: "replays", path: "/replays", title: "Replays", nav: "Replays", group: "Compete" },
  { id: "profile", path: "/profile", title: "Profile", nav: "Profile", group: "You" },
  { id: "settings", path: "/settings", title: "Settings", nav: "Settings", group: "You" },
  { id: "data", path: "/data", title: "Data export and backup", nav: "Data & backup", group: "You" },
];

export function routeHref(id: RouteId): string {
  const route = ROUTES.find((r) => r.id === id);
  return `#${route?.path ?? "/"}`;
}

export function routeFromHash(hash: string): RouteDef | null {
  const path = hash.replace(/^#/, "").split("?")[0] || "/";
  return ROUTES.find((r) => r.path === path) ?? null;
}

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useHash(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
}

export function navigate(id: RouteId): void {
  window.location.hash = routeHref(id);
}
