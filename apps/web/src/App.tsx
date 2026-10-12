import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ROUTES, routeFromHash, routeHref, useHash } from "./app/routes.js";
import type { RouteGroup, RouteId } from "./app/routes.js";
import { ServicesProvider, useServices, useSettings } from "./app/services.js";
import type { AppServices } from "./app/services.js";
import { LiveRegion } from "./components/LiveRegion.js";
import { ConnectionBanner, IdentityChip } from "./components/StatusBar.js";
import { DataScreen } from "./screens/DataScreen.js";
import { ModesScreen } from "./screens/ModesScreen.js";
import {
  BotLabScreen,
  ChallengesScreen,
  DuelScreen,
  LeaderboardsScreen,
  LobbyScreen,
  ReplaysScreen,
} from "./screens/PendingScreens.js";
import { ProfileScreen } from "./screens/ProfileScreen.js";
import { PlayScreen } from "./screens/PlayScreen.js";
import { PracticeScreen } from "./screens/PracticeScreen.js";
import { SavesScreen } from "./screens/SavesScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { WelcomeScreen } from "./screens/WelcomeScreen.js";
import { applyAppearance, readMediaPrefs } from "./settings/appearance.js";

const SCREENS: Record<RouteId, () => ReactElement> = {
  welcome: WelcomeScreen,
  modes: ModesScreen,
  play: PlayScreen,
  practice: PracticeScreen,
  saves: SavesScreen,
  challenges: ChallengesScreen,
  leaderboards: LeaderboardsScreen,
  profile: ProfileScreen,
  lobby: LobbyScreen,
  duel: DuelScreen,
  bots: BotLabScreen,
  replays: ReplaysScreen,
  settings: SettingsScreen,
  data: DataScreen,
};

const GROUPS: RouteGroup[] = ["Play", "Compete", "You"];

/** Keeps <html data-theme / data-motion> in sync with settings and OS media preferences. */
function useAppearance() {
  const settings = useSettings();
  useEffect(() => {
    const apply = () => applyAppearance(document.documentElement, settings, readMediaPrefs(window));
    apply();
    if (typeof window.matchMedia !== "function") return;
    const queries = [
      "(prefers-color-scheme: dark)",
      "(prefers-contrast: more)",
      "(forced-colors: active)",
      "(prefers-reduced-motion: reduce)",
    ].map((q) => window.matchMedia(q));
    for (const q of queries) q.addEventListener("change", apply);
    return () => {
      for (const q of queries) q.removeEventListener("change", apply);
    };
  }, [settings]);
}

function Shell() {
  const { announcer } = useServices();
  const hash = useHash();
  const route = routeFromHash(hash);
  const [menuOpen, setMenuOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousRoute = useRef<string | null>(null);
  useAppearance();

  // Move focus to the new page heading on in-app navigation (not on first load).
  useEffect(() => {
    const id = route?.id ?? "missing";
    if (previousRoute.current !== null && previousRoute.current !== id) headingRef.current?.focus();
    previousRoute.current = id;
    document.title = route ? `${route.title} · 2048 Infinite` : "Not found · 2048 Infinite";
  }, [route]);

  const Screen = route ? SCREENS[route.id] : null;

  return (
    <div className="shell">
      {/* The hash is used for routing, so the skip link moves focus itself instead of changing the hash. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          headingRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="masthead">
        <a className="brand" href={routeHref("welcome")} aria-label="2048 Infinite home">
          <span className="brand__mark" aria-hidden="true">
            2<sup>∞</sup>
          </span>
          <span className="brand__name">2048 Infinite</span>
        </a>
        <div className="masthead__right">
          <IdentityChip />
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="site-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span aria-hidden="true" className="menu-toggle__icon" />
            Menu
          </button>
        </div>
      </header>
      <ConnectionBanner />
      <nav id="site-nav" className="site-nav" data-open={menuOpen} aria-label="Main">
        {GROUPS.map((group) => (
          <div className="site-nav__group" key={group}>
            <p className="site-nav__heading" id={`nav-${group}`}>
              {group}
            </p>
            <ul aria-labelledby={`nav-${group}`}>
              {ROUTES.filter((r) => r.group === group).map((r) => (
                <li key={r.id}>
                  <a
                    href={routeHref(r.id)}
                    aria-current={route?.id === r.id ? "page" : undefined}
                    onClick={() => setMenuOpen(false)}
                  >
                    {r.nav}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <main id="main" className="main" tabIndex={-1}>
        <h1 className="page-title" ref={headingRef} tabIndex={-1}>
          {route ? route.title : "Page not found"}
        </h1>
        {Screen ? (
          <Screen />
        ) : (
          <section className="panel">
            <p>There is no screen at this address.</p>
            <a className="button button--primary" href={routeHref("welcome")}>
              Go to the start
            </a>
          </section>
        )}
      </main>
      <footer className="footer">
        <p>Runs entirely on this computer · nothing is sent over the network.</p>
      </footer>
      <LiveRegion announcer={announcer} />
    </div>
  );
}

export function App({ services }: { services: AppServices }) {
  return (
    <ServicesProvider services={services}>
      <Shell />
    </ServicesProvider>
  );
}
