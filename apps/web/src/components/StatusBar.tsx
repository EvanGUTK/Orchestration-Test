import { routeHref } from "../app/routes.js";
import { useAuth, useConnection, useServices } from "../app/services.js";

/** Masthead chip: who is playing (guest vs account), never ambiguous. */
export function IdentityChip() {
  const auth = useAuth();
  if (auth.status === "signed-in") {
    return (
      <a
        className="identity identity--account"
        href={routeHref("profile")}
        aria-label={`Signed in as ${auth.user.displayName}. Account settings`}
      >
        <span className="identity__dot" aria-hidden="true" />
        <span className="identity__name">{auth.user.displayName}</span>
      </a>
    );
  }
  return (
    <a
      className="identity identity--guest"
      href={routeHref("welcome")}
      aria-label={
        auth.status === "offline" ? "Guest, offline. Sign-in unavailable" : "Playing as guest. Sign in"
      }
    >
      <span className="identity__dot" aria-hidden="true" />
      <span className="identity__name">{auth.status === "offline" ? "Guest · offline" : "Guest"}</span>
    </a>
  );
}

/** Reconnect / offline banner shared by every screen (UI-05). */
export function ConnectionBanner() {
  const { auth } = useServices();
  const authState = useAuth();
  const connection = useConnection();
  if (connection.kind === "retrying") {
    return (
      <div className="banner banner--warn" role="status">
        Reconnecting to the local server… (attempt {connection.attempt} of {connection.of}). Your moves are
        kept in order.
      </div>
    );
  }
  if (connection.kind === "offline" && authState.status === "signed-in") {
    return (
      <div className="banner banner--error" role="alert">
        <span>Lost contact with the local server. {connection.message}</span>
        <button type="button" className="button button--small" onClick={() => void auth.refresh()}>
          Check again
        </button>
      </div>
    );
  }
  return null;
}
