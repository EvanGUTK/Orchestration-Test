import { useState } from "react";
import type { FormEvent } from "react";
import { ApiRequestError, describeError } from "../api/client.ts";
import { ErrorPanel, Field, PageHeading } from "../components/common.tsx";
import { Link, useNavigate } from "../router.tsx";
import { useApp } from "../state/app.tsx";
import { useStartGame } from "../state/startGame.ts";

export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

export function validateRegistration(input: { username: string; displayName: string; password: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  const username = input.username.toLowerCase();
  if (!USERNAME_PATTERN.test(username)) errors["username"] = "Use 3 to 24 letters, digits or underscores.";
  const nameLength = [...input.displayName.trim()].length;
  if (nameLength < 1 || nameLength > 48) errors["displayName"] = "Display name must be 1 to 48 characters.";
  if (input.password.length < 12 || input.password.length > 128) errors["password"] = "Password must be 12 to 128 characters.";
  return errors;
}

export function WelcomeScreen() {
  const { identity, isUser, serverStatus } = useApp();
  const { start, busy, error } = useStartGame();
  return (
    <>
      <PageHeading title="2048 Infinite" subtitle="There is no final tile. Everything runs and stays on this machine." />
      <div className="card-grid">
        <section className="panel">
          <h2 className="panel-title">Play now</h2>
          <p className="muted">A guest game is casual and never ranked. It is saved so you can resume it, on the local server when it is running or in this browser when it is not.</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start("classic")}>
            {busy ? "Starting..." : isUser ? "Quick classic game" : "Play as guest"}
          </button>
          {error ? <ErrorPanel error={error} /> : null}
        </section>
        {isUser && identity ? (
          <section className="panel">
            <h2 className="panel-title">Welcome back, {identity.displayName}</h2>
            <p className="muted">Server games are saved, can be ranked, and can be replayed.</p>
            <Link to="/modes" className="btn btn-primary">
              Choose a mode
            </Link>
          </section>
        ) : (
          <section className="panel">
            <h2 className="panel-title">Local account</h2>
            <p className="muted">
              Create a local account to save games on the server, enter ranked challenges and duels. No email or cloud account is used.
            </p>
            {serverStatus === "offline" ? (
              <p className="notice" role="status">
                The local game server is not reachable, so accounts are unavailable right now. Guest play still works.
              </p>
            ) : null}
            <div className="row">
              <Link to="/register" className="btn btn-primary">
                Create account
              </Link>
              <Link to="/login" className="btn">
                Sign in
              </Link>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

export function AuthScreen(props: { mode: "login" | "register" }) {
  const { signIn, register } = useApp();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRegister = props.mode === "register";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (isRegister) {
      const found = validateRegistration({ username, displayName, password });
      setErrors(found);
      if (Object.keys(found).length > 0) return;
    } else {
      setErrors({});
    }
    setBusy(true);
    try {
      if (isRegister) await register({ username: username.toLowerCase(), displayName: displayName.trim(), password });
      else await signIn({ username: username.toLowerCase(), password });
      navigate("/modes");
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "RATE_LIMITED") {
        setFormError("Too many sign-in attempts. Wait a bit before trying again.");
      } else if (error instanceof ApiRequestError && error.code === "UNAUTHENTICATED") {
        setFormError("Wrong username or password.");
      } else {
        const info = describeError(error);
        setFormError(`${info.title}. ${info.detail} ${info.action}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeading title={isRegister ? "Create a local account" : "Sign in"} subtitle="Stored only on this machine." />
      <form className="panel form" onSubmit={(e) => void submit(e)} noValidate aria-label={isRegister ? "Create account" : "Sign in"}>
        <Field id="username" label="Username" hint={isRegister ? "Lowercase letters, digits and underscores, 3 to 24 characters." : undefined} error={errors["username"] ?? null}>
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-invalid={errors["username"] ? true : undefined}
            aria-describedby={errors["username"] ? "username-error" : isRegister ? "username-hint" : undefined}
            required
          />
        </Field>
        {isRegister ? (
          <Field id="displayName" label="Display name" hint="1 to 48 characters. Shown on leaderboards." error={errors["displayName"] ?? null}>
            <input
              id="displayName"
              name="displayName"
              autoComplete="nickname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              aria-invalid={errors["displayName"] ? true : undefined}
              aria-describedby={errors["displayName"] ? "displayName-error" : "displayName-hint"}
              required
            />
          </Field>
        ) : null}
        <Field id="password" label="Password" hint={isRegister ? "12 to 128 characters." : undefined} error={errors["password"] ?? null}>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={isRegister ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={errors["password"] ? true : undefined}
            aria-describedby={errors["password"] ? "password-error" : isRegister ? "password-hint" : undefined}
            required
          />
        </Field>
        {formError ? (
          <p className="field-error" role="alert">
            {formError}
          </p>
        ) : null}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Working..." : isRegister ? "Create account" : "Sign in"}
          </button>
          <Link to={isRegister ? "/login" : "/register"} className="btn">
            {isRegister ? "I already have an account" : "Create an account instead"}
          </Link>
        </div>
        <p className="muted">There is no password recovery by email. A forgotten password is reset by the machine owner.</p>
      </form>
    </>
  );
}
