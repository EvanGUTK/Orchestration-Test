import { useState } from "react";
import type { FormEvent } from "react";
import { describeApiError, formatWait, isApiError } from "../api/client.js";
import { routeHref } from "../app/routes.js";
import { useAuth, useServices } from "../app/services.js";
import { Field } from "../components/Field.js";
import { displayNameError, passwordError } from "../lib/validation.js";

function DisplayNameForm({ current }: { current: string }) {
  const { auth } = useServices();
  const [value, setValue] = useState(current);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = displayNameError(value);
    if (problem) {
      setStatus({ ok: false, text: problem });
      return;
    }
    setBusy(true);
    try {
      await auth.updateDisplayName(value);
      setStatus({ ok: true, text: "Display name saved." });
    } catch (error) {
      setStatus({ ok: false, text: describeApiError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" aria-label="Display name" onSubmit={(e) => void submit(e)} noValidate>
      <Field
        label="Display name"
        autoComplete="nickname"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        hint="1–48 characters."
        error={status && !status.ok ? status.text : undefined}
      />
      <div className="action-row">
        <button type="submit" className="button" disabled={busy || value === current}>
          Save display name
        </button>
      </div>
      {status?.ok && (
        <p className="hint" role="status">
          {status.text}
        </p>
      )}
    </form>
  );
}

function PasswordForm() {
  const { auth } = useServices();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = !current
      ? "Enter your current password."
      : (passwordError(next) ?? (next !== confirm ? "New passwords don't match." : null));
    if (problem) {
      setResult({ ok: false, text: problem });
      return;
    }
    setBusy(true);
    try {
      const revoked = await auth.changePassword(current, next);
      setResult({
        ok: true,
        text: `Password changed.${revoked ? ` Signed out ${revoked} other session(s).` : ""}`,
      });
    } catch (error) {
      setResult({
        ok: false,
        text:
          isApiError(error) && error.code === "RATE_LIMITED"
            ? `Too many attempts. Try again in ${formatWait(error.retryAfterMs)}.`
            : isApiError(error) && (error.code === "UNAUTHENTICATED" || error.code === "VALIDATION_ERROR")
              ? "The current password is incorrect, or the new one isn't allowed."
              : describeApiError(error),
      });
    } finally {
      setCurrent("");
      setNext("");
      setConfirm("");
      setBusy(false);
    }
  };

  return (
    <form className="form" aria-label="Change password" onSubmit={(e) => void submit(e)} noValidate>
      <div className="form__fields">
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint="At least 12 characters. Other sessions of this account are signed out."
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {result && (
          <p className={result.ok ? "notice" : "notice notice--error"} role={result.ok ? "status" : "alert"}>
            {result.text}
          </p>
        )}
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Changing…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

export function ProfileScreen() {
  const { auth: store } = useServices();
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (auth.status !== "signed-in") {
    return (
      <section className="panel" aria-labelledby="profile-guest">
        <h2 className="panel__title" id="profile-guest">
          {auth.status === "offline" ? "Server not reachable" : "You're playing as a guest"}
        </h2>
        <p>
          {auth.status === "offline"
            ? "Profiles live on the local 2048 Infinite server, which isn't responding. Guest play still works."
            : "Sign in or create a local account to keep a profile, saves and statistics on this computer."}
        </p>
        {message && <p role="status">{message}</p>}
        <div className="action-row">
          <a className="button button--primary" href={routeHref("welcome")}>
            Sign in or create account
          </a>
        </div>
      </section>
    );
  }

  const signOut = async (everywhere: boolean) => {
    setBusy(true);
    try {
      const revoked = await store.logout(everywhere);
      setMessage(everywhere ? `Signed out of ${revoked ?? "all"} session(s).` : "Signed out.");
    } catch (error) {
      setMessage(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="profile-account">
        <h2 className="panel__title" id="profile-account">
          Account
        </h2>
        <dl className="facts">
          <dt>Username</dt>
          <dd>
            <code>{auth.user.username}</code>
          </dd>
          <dt>Member since</dt>
          <dd>{new Date(auth.user.createdAt).toLocaleDateString()}</dd>
        </dl>
        <DisplayNameForm key={auth.user.displayName} current={auth.user.displayName} />
      </section>

      <section className="panel" aria-labelledby="profile-security">
        <h2 className="panel__title" id="profile-security">
          Password and sessions
        </h2>
        <PasswordForm />
        <div className="action-row">
          <button
            type="button"
            className="button button--ghost"
            disabled={busy}
            onClick={() => void signOut(false)}
          >
            Sign out
          </button>
          <button
            type="button"
            className="button button--danger"
            disabled={busy}
            onClick={() => void signOut(true)}
          >
            Sign out everywhere
          </button>
        </div>
        <p className="hint hint--small">
          Forgot your password? There is no email reset: the computer's owner can reset it with the local
          owner tool.
        </p>
      </section>

      <section className="panel" aria-labelledby="profile-duels">
        <h2 className="panel__title" id="profile-duels">
          Two players on one computer
        </h2>
        <p>
          One browser profile holds one signed-in account. For a 1v1 duel, the second player signs in from a
          different browser profile (or another browser), so each seat has its own session.
        </p>
      </section>

      <section className="panel panel--unavailable" aria-labelledby="profile-stats">
        <h2 className="panel__title" id="profile-stats">
          Statistics
        </h2>
        <p className="badge badge--pending">Not available yet</p>
        <p>
          Personal bests, score distribution, highest tiles, win/draw/loss and ranked history will appear here
          once the server reports them. Nothing is estimated.
        </p>
      </section>
    </div>
  );
}
