import { Component, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { LeaderboardKind } from "@2048/contracts";
import { EmptyState, ErrorPanel } from "./components/common.tsx";
import { Link, useRoute } from "./router.tsx";
import { useApp } from "./state/app.tsx";
import { AuthScreen, WelcomeScreen } from "./screens/Auth.tsx";
import { ModesScreen } from "./screens/Modes.tsx";
import { LocalPlayScreen, RemotePlayScreen } from "./screens/Play.tsx";
import { ChallengeDetailScreen, ChallengesScreen, LeaderboardsScreen, PracticeScreen, SavesScreen } from "./screens/Lists.tsx";
import { DataScreen, ProfileScreen, SettingsScreen } from "./screens/Account.tsx";
import { BotLabScreen, DuelLobbyScreen, DuelScreen } from "./screens/Competition.tsx";
import { ReplayHomeScreen, ReplayScreen } from "./screens/Replay.tsx";

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null });
  }
  override render() {
    if (this.state.error !== null) {
      return (
        <ErrorPanel
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
          extra={
            <Link to="/" className="btn">
              Back to start
            </Link>
          }
        />
      );
    }
    return this.props.children;
  }
}

const NAV: { to: string; label: string; needsAccount?: boolean }[] = [
  { to: "/modes", label: "Play" },
  { to: "/saves", label: "Saved games" },
  { to: "/challenges", label: "Challenges", needsAccount: true },
  { to: "/duel", label: "Duels", needsAccount: true },
  { to: "/bots", label: "Bot lab", needsAccount: true },
  { to: "/leaderboards", label: "Leaderboards" },
  { to: "/replays", label: "Replays" },
  { to: "/settings", label: "Settings" },
  { to: "/data", label: "Data" },
];

function Header() {
  const { identity, isUser, serverStatus, signOut } = useApp();
  const route = useRoute();
  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="2048 Infinite home">
        <span aria-hidden="true">2048</span> <span className="brand-inf" aria-hidden="true">&infin;</span>
        <span className="sr-only">2048 Infinite</span>
      </Link>
      <nav aria-label="Main">
        <ul className="nav">
          {NAV.map((item) => (
            <li key={item.to}>
              <a
                href={`#${item.to}`}
                className={`nav-link${route.path === item.to || route.path.startsWith(`${item.to}/`) ? " nav-active" : ""}`}
                aria-current={route.path === item.to ? "page" : undefined}
                title={item.needsAccount && !isUser ? "Needs a local account" : undefined}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="account" aria-label="Account">
        {serverStatus === "offline" ? (
          <span className="tag tag-warn" role="status">
            Server offline
          </span>
        ) : null}
        {isUser && identity ? (
          <>
            <Link to="/profile" className="nav-link">
              {identity.displayName}
            </Link>
            <button type="button" className="btn btn-small" onClick={() => void signOut()}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <span className="muted">{identity ? identity.displayName : "Guest (offline)"}</span>
            <Link to="/login" className="btn btn-small">
              Sign in
            </Link>
          </>
        )}
      </div>
    </header>
  );
}

function renderRoute(segments: string[], params: URLSearchParams): ReactNode {
  const [head, second] = segments;
  switch (head) {
    case undefined:
      return <WelcomeScreen />;
    case "login":
      return <AuthScreen mode="login" />;
    case "register":
      return <AuthScreen mode="register" />;
    case "modes":
      return <ModesScreen />;
    case "play":
      return second ? <RemotePlayScreen id={second} /> : <LocalPlayScreen />;
    case "practice":
      return <PracticeScreen />;
    case "saves":
      return <SavesScreen />;
    case "challenges":
      return second ? <ChallengeDetailScreen id={second} /> : <ChallengesScreen />;
    case "leaderboards": {
      const kind = params.get("kind") as LeaderboardKind | null;
      const challenge = params.get("challenge");
      return <LeaderboardsScreen key={`${kind}|${challenge}`} {...(kind ? { initialKind: kind } : {})} {...(challenge ? { initialChallenge: challenge } : {})} />;
    }
    case "profile":
      return <ProfileScreen />;
    case "duel":
      return second ? <DuelScreen id={second} /> : <DuelLobbyScreen />;
    case "bots":
      return <BotLabScreen />;
    case "replays":
      return second ? <ReplayScreen id={second} /> : <ReplayHomeScreen />;
    case "settings":
      return <SettingsScreen />;
    case "data":
      return <DataScreen />;
    default:
      return (
        <EmptyState title="Page not found">
          There is nothing at this address. <Link to="/">Go to the start page</Link>.
        </EmptyState>
      );
  }
}

export function App() {
  const route = useRoute();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the page heading on navigation so keyboard and screen reader users land at the new content.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const heading = main.current?.querySelector<HTMLElement>("[data-page-heading]");
    (heading ?? main.current)?.focus({ preventScroll: false });
  }, [route.path]);

  return (
    <>
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>
        Skip to content
      </a>
      <Header />
      <main id="main" ref={main} tabIndex={-1} className="app-main">
        <ErrorBoundary resetKey={route.path}>{renderRoute(route.segments, route.params)}</ErrorBoundary>
      </main>
      <footer className="app-footer muted">Everything runs on this machine. No network calls leave it.</footer>
    </>
  );
}
