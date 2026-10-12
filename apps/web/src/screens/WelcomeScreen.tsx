import { useId, useState } from "react";
import type { FormEvent } from "react";
import { describeApiError, formatWait, isApiError } from "../api/client.js";
import { navigate, routeHref } from "../app/routes.js";
import { useAuth, useServices } from "../app/services.js";
import { Field } from "../components/Field.js";
import { normalizeUsername, validateRegistration } from "../lib/validation.js";
import type { RegisterErrors } from "../lib/validation.js";

/** Login failures are deliberately generic: never reveal whether the username exists. */
export function loginErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "RATE_LIMITED") {
      return `Too many sign-in attempts. Try again in ${formatWait(error.retryAfterMs)}.`;
    }
    if (error.code === "UNAUTHENTICATED" || error.code === "VALIDATION_ERROR" || error.code === "FORBIDDEN") {
      return "Username or password is incorrect.";
    }
  }
  return describeApiError(error);
}

function SignInForm() {
  const { auth } = useServices();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.login(normalizeUsername(username.trim()), password);
      setPassword("");
      navigate("play");
    } catch (err) {
      setPassword("");
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" aria-label="Sign in" onSubmit={(e) => void submit(e)} noValidate aria-busy={busy}>
      <div className="form__fields">
        <Field
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}

function RegisterForm() {
  const { auth } = useServices();
  const [values, setValues] = useState({ username: "", displayName: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<RegisterErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateRegistration(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setError("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.register(normalizeUsername(values.username), values.displayName, values.password);
      navigate("play");
    } catch (err) {
      setError(
        isApiError(err) && err.code === "RATE_LIMITED"
          ? `Too many attempts. Try again in ${formatWait(err.retryAfterMs)}.`
          : `Couldn't create the account. ${describeApiError(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const normalized = normalizeUsername(values.username);
  return (
    <form
      className="form"
      aria-label="Create account"
      onSubmit={(e) => void submit(e)}
      noValidate
      aria-busy={busy}
    >
      <div className="form__fields">
        <Field
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={values.username}
          onChange={set("username")}
          hint={`3–24 characters: a–z, 0–9, underscore. Stored lowercase${normalized && normalized !== values.username ? ` as “${normalized}”` : ""}.`}
          error={errors.username}
        />
        <Field
          label="Display name"
          autoComplete="nickname"
          value={values.displayName}
          onChange={set("displayName")}
          hint="1–48 characters, shown on leaderboards."
          error={errors.displayName}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={set("password")}
          hint="At least 12 characters. There is no email recovery — the computer's owner can reset it locally."
          error={errors.password}
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={values.confirm}
          onChange={set("confirm")}
          error={errors.confirm}
        />
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </div>
    </form>
  );
}

export function WelcomeScreen() {
  const { localGame, auth: authStore } = useServices();
  const auth = useAuth();
  const id = useId();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);

  return (
    <div className="welcome">
      <section className="hero" aria-labelledby={`${id}-hero`}>
        <p className="hero__mark" aria-hidden="true">
          2<sup>∞</sup>
        </p>
        <h2 id={`${id}-hero`} className="hero__title">
          Merge past 2048. Keep going.
        </h2>
        <p className="lede">
          No winning tile, no score ceiling, every value exact. Everything runs and stays on this computer.
        </p>
        <div className="action-row">
          {auth.status === "signed-in" ? (
            <a className="button button--primary" href={routeHref("play")}>
              Continue as {auth.user.displayName}
            </a>
          ) : (
            <a className="button button--primary" href={routeHref(localGame ? "play" : "modes")}>
              Play as guest
            </a>
          )}
          <a className="button button--ghost" href={routeHref("modes")}>
            Browse modes
          </a>
        </div>
      </section>

      <section className="panel" aria-labelledby={`${id}-accounts`} aria-busy={auth.status === "loading"}>
        <h2 id={`${id}-accounts`} className="panel__title">
          Local account
        </h2>
        {auth.status === "loading" && <p role="status">Checking for the local server…</p>}

        {auth.status === "offline" && (
          <>
            <p className="badge badge--pending">Server not reachable</p>
            <p>
              Accounts live on the local 2048 Infinite server, which isn't responding ({auth.message}). You
              can keep playing as a guest; guest games are saved in this browser.
            </p>
            <div className="action-row">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void authStore.refresh().finally(() => setBusy(false));
                }}
              >
                {busy ? "Checking…" : "Try again"}
              </button>
            </div>
          </>
        )}

        {auth.status === "signed-in" && (
          <>
            <p>
              Signed in as <strong>{auth.user.displayName}</strong> (<code>{auth.user.username}</code>). Your
              games and preferences are saved on the local server.
            </p>
            <div className="action-row">
              <a className="button" href={routeHref("profile")}>
                Account settings
              </a>
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void authStore.logout().finally(() => setBusy(false));
                }}
              >
                Sign out
              </button>
            </div>
          </>
        )}

        {auth.status === "guest" && (
          <>
            <p>
              Create an account with a username, display name and password — no email or online service.
              Accounts can save games on this computer, enter ranked challenges and play duels.
            </p>
            <div className="tabs" role="tablist" aria-label="Account">
              <button
                type="button"
                role="tab"
                id={`${id}-tab-login`}
                aria-selected={tab === "login"}
                aria-controls={`${id}-panel`}
                className="tabs__tab"
                onClick={() => setTab("login")}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                id={`${id}-tab-register`}
                aria-selected={tab === "register"}
                aria-controls={`${id}-panel`}
                className="tabs__tab"
                onClick={() => setTab("register")}
              >
                Create account
              </button>
            </div>
            <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
              {tab === "login" ? <SignInForm /> : <RegisterForm />}
            </div>
            <p className="hint hint--small">
              Two players on one computer: each player signs in from a separate browser profile (or a private
              window) to hold two sessions at once. One browser profile holds one signed-in account.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
