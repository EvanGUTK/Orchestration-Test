import { useState } from "react";
import type { FormEvent } from "react";
import type { Preferences } from "@2048/contracts";
import { compareDecimal } from "@2048/contracts";
import { Field, EmptyState, ErrorPanel, PageHeading, Spinner } from "../components/common.tsx";
import { groupDecimal, maxExponentOf, tileLabel } from "../format.ts";
import { parseBindingText } from "../input/keys.ts";
import { Link, useNavigate } from "../router.tsx";
import { useApp } from "../state/app.tsx";
import { useAsync } from "../state/useAsync.ts";

// --- profile -----------------------------------------------------------------------
export function ProfileScreen() {
  const { identity, api, setIdentity, signOut } = useApp();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(identity?.displayName ?? "");
  const [nameMessage, setNameMessage] = useState<string | null>(null);
  const [nameError, setNameError] = useState<unknown>(null);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<unknown>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const stats = useAsync(
    async (signal) => {
      if (!identity) return null;
      const games = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await api.listGames(cursor, signal);
        games.push(...page.items);
        if (!page.nextCursor) return { games, truncated: false };
        cursor = page.nextCursor;
      }
      return { games, truncated: true };
    },
    [api, identity?.userId],
  );

  if (!identity) {
    return (
      <>
        <PageHeading title="Profile" />
        <EmptyState title="You are playing as a guest">
          Guest results are stored only in this browser and never ranked. <Link to="/register">Create an account</Link> to keep statistics.
        </EmptyState>
      </>
    );
  }

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    setNameMessage(null);
    setNameError(null);
    const length = [...displayName.trim()].length;
    if (length < 1 || length > 48) {
      setNameError(new Error("Display name must be 1 to 48 characters."));
      return;
    }
    try {
      const updated = await api.patchProfile({ displayName: displayName.trim() });
      setIdentity(updated);
      setNameMessage("Display name saved.");
    } catch (e) {
      setNameError(e);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordMessage(null);
    setPasswordError(null);
    if (newPassword.length < 12 || newPassword.length > 128) {
      setPasswordError(new Error("The new password must be 12 to 128 characters."));
      return;
    }
    try {
      await api.changePassword({ oldPassword, newPassword });
      setOldPassword("");
      setNewPassword("");
      setPasswordMessage("Password changed. Your other sessions were signed out.");
    } catch (e) {
      setPasswordError(e);
    }
  };

  const deleteAccount = async (event: FormEvent) => {
    event.preventDefault();
    setDeleteError(null);
    try {
      await api.deleteProfile({ password: deletePassword });
      setIdentity(null);
      navigate("/");
    } catch (e) {
      setDeleteError(e);
    }
  };

  let summary: { played: number; completed: number; bestScore: string; bestTile: string | null; truncated: boolean } | null = null;
  if (stats.status === "ready" && stats.data) {
    const { games, truncated } = stats.data;
    let bestScore = "0";
    const cells: (string | null)[] = [];
    for (const g of games) {
      if (compareDecimal(g.state.score, bestScore) > 0) bestScore = g.state.score;
      cells.push(maxExponentOf(g.state.board.cells));
    }
    summary = {
      played: games.length,
      completed: games.filter((g) => g.state.status !== "active").length,
      bestScore,
      bestTile: maxExponentOf(cells),
      truncated,
    };
  }

  return (
    <>
      <PageHeading
        title="Profile"
        subtitle={`${identity.displayName} (@${identity.username ?? "guest"})`}
        actions={
          <button type="button" className="btn" onClick={() => void signOut().then(() => navigate("/"))}>
            Sign out
          </button>
        }
      />
      <section className="panel" aria-label="Statistics">
        <h2 className="panel-title">Statistics</h2>
        {stats.status === "loading" ? (
          <Spinner label="Loading your games" />
        ) : stats.status === "error" ? (
          <ErrorPanel error={stats.error} onRetry={stats.reload} />
        ) : summary && summary.played > 0 ? (
          <dl className="stats">
            <div>
              <dt>Games</dt>
              <dd>{summary.played}{summary.truncated ? "+" : ""}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{summary.completed}</dd>
            </div>
            <div>
              <dt>Best score</dt>
              <dd title={summary.bestScore}>{groupDecimal(summary.bestScore)}</dd>
            </div>
            <div>
              <dt>Best tile</dt>
              <dd>{summary.bestTile ? tileLabel(summary.bestTile, "numbers") : "-"}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">No games yet. Statistics are computed from your saved games, nothing is estimated.</p>
        )}
        <p className="muted">Win, draw and loss records and Elo are on the <Link to="/leaderboards">leaderboards</Link>.</p>
      </section>

      <form className="panel form" onSubmit={(e) => void saveName(e)} aria-label="Display name">
        <h2 className="panel-title">Display name</h2>
        <Field id="p-name" label="Display name">
          <input id="p-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <button type="submit" className="btn">
          Save name
        </button>
        {nameMessage ? <p role="status">{nameMessage}</p> : null}
        {nameError ? <ErrorPanel error={nameError} /> : null}
      </form>

      <form className="panel form" onSubmit={(e) => void changePassword(e)} aria-label="Change password">
        <h2 className="panel-title">Change password</h2>
        <Field id="p-old" label="Current password">
          <input id="p-old" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
        </Field>
        <Field id="p-new" label="New password" hint="12 to 128 characters.">
          <input id="p-new" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} aria-describedby="p-new-hint" />
        </Field>
        <button type="submit" className="btn">
          Change password
        </button>
        {passwordMessage ? <p role="status">{passwordMessage}</p> : null}
        {passwordError ? <ErrorPanel error={passwordError} /> : null}
      </form>

      <section className="panel" aria-label="Delete account">
        <h2 className="panel-title">Delete account</h2>
        <p className="muted">Removes your private data. Finished matches stay as anonymised history so replays still work.</p>
        {deleteOpen ? (
          <form className="form" onSubmit={(e) => void deleteAccount(e)}>
            <Field id="p-del" label="Confirm with your password">
              <input id="p-del" type="password" autoComplete="current-password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />
            </Field>
            <div className="row">
              <button type="submit" className="btn btn-danger">
                Delete my account
              </button>
              <button type="button" className="btn" onClick={() => setDeleteOpen(false)}>
                Cancel
              </button>
            </div>
            {deleteError ? <ErrorPanel error={deleteError} /> : null}
          </form>
        ) : (
          <button type="button" className="btn btn-danger" onClick={() => setDeleteOpen(true)}>
            Delete account...
          </button>
        )}
      </section>
    </>
  );
}

// --- settings ----------------------------------------------------------------------
const THEME_OPTIONS: { value: Preferences["theme"]; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "high-contrast", label: "High contrast" },
];
const MOTION_OPTIONS: { value: Preferences["motion"]; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "full", label: "Full animation" },
  { value: "reduced", label: "Reduced motion" },
];
const TILE_OPTIONS: { value: Preferences["tileStyle"]; label: string }[] = [
  { value: "numbers-pattern", label: "Numbers with patterns" },
  { value: "numbers", label: "Numbers only" },
  { value: "powers", label: "Powers of two (2^n)" },
];
const SPEED_OPTIONS: { value: Preferences["botSpeed"]; label: string }[] = [
  { value: "slow", label: "Slow" },
  { value: "normal", label: "Normal" },
  { value: "fast", label: "Fast" },
];

export function SettingsScreen() {
  const { prefs, updatePrefs, identity } = useApp();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bindingText, setBindingText] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(prefs.keyBindings).map(([direction, keys]) => [direction, keys.join(", ")])),
  );

  const apply = async (patch: Partial<Preferences>) => {
    setMessage(null);
    setError(null);
    try {
      await updatePrefs(patch);
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  };

  const saveBindings = async (event: FormEvent) => {
    event.preventDefault();
    const next = { ...prefs.keyBindings };
    for (const direction of ["up", "right", "down", "left"] as const) {
      const keys = parseBindingText(bindingText[direction] ?? "");
      if (keys.length === 0) {
        setError(`Give at least one key for ${direction}.`);
        return;
      }
      next[direction] = keys;
    }
    const all = Object.values(next).flat().map((k) => (k.length === 1 ? k.toLowerCase() : k));
    if (new Set(all).size !== all.length) {
      setError("A key can only be bound to one direction.");
      return;
    }
    await apply({ keyBindings: next });
  };

  const select = <K extends "theme" | "motion" | "tileStyle" | "botSpeed">(id: string, label: string, key: K, options: { value: Preferences[K]; label: string }[]) => (
    <Field id={id} label={label}>
      <select id={id} value={prefs[key]} onChange={(e) => void apply({ [key]: e.target.value } as Partial<Preferences>)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <>
      <PageHeading title="Settings" subtitle={identity ? "Saved to your account." : "Saved in this browser for guests."} />
      <div className="panel form" role="group" aria-label="Appearance and behaviour">
        {select("s-theme", "Theme", "theme", THEME_OPTIONS)}
        {select("s-motion", "Motion", "motion", MOTION_OPTIONS)}
        {select("s-tiles", "Tile display", "tileStyle", TILE_OPTIONS)}
        {select("s-speed", "Bot speed", "botSpeed", SPEED_OPTIONS)}
        <div className="field field-check">
          <input id="s-mute" type="checkbox" checked={prefs.soundMuted} onChange={(e) => void apply({ soundMuted: e.target.checked })} />
          <label htmlFor="s-mute">Mute sound</label>
          <p className="hint">The app ships no sound effects yet, so this preference is stored for when they are added.</p>
        </div>
      </div>
      <form className="panel form" onSubmit={(e) => void saveBindings(e)} aria-label="Keyboard bindings">
        <h2 className="panel-title">Keyboard bindings</h2>
        <p className="muted">Comma separated key names such as ArrowUp, w, k. Only used while the board has focus.</p>
        {(["up", "right", "down", "left"] as const).map((direction) => (
          <Field key={direction} id={`k-${direction}`} label={`Keys for ${direction}`}>
            <input id={`k-${direction}`} value={bindingText[direction] ?? ""} onChange={(e) => setBindingText({ ...bindingText, [direction]: e.target.value })} spellCheck={false} autoCapitalize="none" />
          </Field>
        ))}
        <button type="submit" className="btn">
          Save bindings
        </button>
      </form>
      <p role="status" className="muted">
        {message}
      </p>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
    </>
  );
}

// --- data export / backup ----------------------------------------------------------
export function DataScreen() {
  const { identity, api } = useApp();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const exportData = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const data = await api.exportProfile();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "2048-infinite-profile-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDone("Export downloaded. It contains no password hash or session token.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeading title="Data and backup" subtitle="Your data lives in a SQLite file on this machine." />
      <section className="panel" aria-label="Export">
        <h2 className="panel-title">Export my profile</h2>
        {identity ? (
          <>
            <p className="muted">Downloads your profile, preferences and results as JSON. Credentials and session data are excluded.</p>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void exportData()}>
              {busy ? "Preparing..." : "Download export"}
            </button>
            {done ? <p role="status">{done}</p> : null}
            {error ? <ErrorPanel error={error} onRetry={() => void exportData()} /> : null}
          </>
        ) : (
          <p className="muted">
            <Link to="/login">Sign in</Link> to export an account. Guest games live only in this browser storage.
          </p>
        )}
      </section>
      <section className="panel" aria-label="Backup and restore">
        <h2 className="panel-title">Database backup and restore</h2>
        <p>Backups are owner operations run in a terminal on this machine, not through the browser:</p>
        <pre className="code">{`npm run db:backup\nnpm run db:restore -- <path-to-backup>`}</pre>
        <p className="muted">
          Restore with the application stopped. The database file location is the DATA_DIR of the server process; the server prints it at startup.
        </p>
      </section>
    </>
  );
}
