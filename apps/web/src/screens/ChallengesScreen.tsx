import { useEffect, useState } from "react";
import type { ChallengeSummary } from "@g2048/contracts";
import { describeApiError, isApiError } from "../api/client.js";
import { navigate, routeHref } from "../app/routes.js";
import { useAuth, useServices } from "../app/services.js";
import { Unavailable } from "../components/Unavailable.js";
import type { ServerGameAdapter } from "../game/server-adapter.js";
import { isUnavailable } from "../ranking/source.js";

type ListState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: ChallengeSummary[]; next: string | null };

function attemptLabel(c: ChallengeSummary): string {
  if (!c.myAttempt) return c.status === "open" ? "Not attempted" : "Closed";
  return c.myAttempt.status === "in-progress"
    ? "Attempt in progress"
    : c.myAttempt.status === "completed"
      ? "Official attempt completed"
      : "Attempt forfeited";
}

export function ChallengesScreen() {
  const { ranking, serverGame } = useServices();
  const auth = useAuth();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const signedIn = auth.status === "signed-in";

  useEffect(() => {
    let cancelled = false;
    ranking.challenges(null).then(
      (page) => {
        if (!cancelled) setList({ kind: "ready", items: page.items, next: page.nextCursor });
      },
      (error: unknown) => {
        if (!cancelled)
          setList(
            isUnavailable(error)
              ? { kind: "unavailable" }
              : { kind: "error", message: describeApiError(error) },
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ranking, reload]);

  const start = async (challenge: ChallengeSummary) => {
    setBusy(challenge.id);
    setActionError(null);
    try {
      const res = await ranking.startAttempt(challenge.id);
      await serverGame.load((adapter) => Promise.resolve((adapter as ServerGameAdapter).adopt(res)));
      navigate("play");
    } catch (error) {
      setActionError(
        isApiError(error) && error.code === "FORBIDDEN"
          ? "You've already used your official attempt for this challenge."
          : `Couldn't start the attempt. ${describeApiError(error)}`,
      );
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  if (list.kind === "unavailable") {
    return (
      <Unavailable
        purpose="Ranked challenges: a fixed 4×4 seed shared by every attempt, 500 accepted moves, no undo, one official attempt per account."
        reason="This server doesn't provide challenges yet. Nothing here is simulated."
        alternatives={[
          { to: "play", label: "Play a guest game" },
          { to: "practice", label: "Custom practice" },
        ]}
      />
    );
  }

  return (
    <div className="stack">
      <section className="panel" aria-busy={list.kind === "loading"}>
        <p>
          Every attempt at a challenge gets the same seed. You get <strong>one official attempt</strong>: it
          ends at 500 accepted moves or a dead board, there is no undo, and leaving with “End game” forfeits
          it. An interrupted attempt can be resumed. Practising the same seed in Custom practice stays casual.
        </p>
        {!signedIn && (
          <p className="notice">
            Guests can't enter ranked challenges.{" "}
            <a href={routeHref("welcome")}>Sign in or create a local account</a>.
          </p>
        )}
        {list.kind === "loading" && <p role="status">Loading challenges…</p>}
        {list.kind === "error" && (
          <div className="notice notice--error" role="alert">
            <p>Couldn't load challenges. {list.message}</p>
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setList({ kind: "loading" });
                setReload((n) => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {actionError && (
          <p className="notice notice--error" role="alert">
            {actionError}
          </p>
        )}
        {list.kind === "ready" && list.items.length === 0 && (
          <p>No challenges are open on this server right now.</p>
        )}
        {list.kind === "ready" && list.items.length > 0 && (
          <ul className="save-list">
            {list.items.map((c) => {
              const resumable = c.myAttempt?.status === "in-progress";
              const canStart = signedIn && c.status === "open" && (!c.myAttempt || resumable);
              return (
                <li key={c.id} className="save-row">
                  <div>
                    <p className="save-row__title">
                      Challenge {c.id} <span className="hint hint--small">· season {c.season}</span>
                    </p>
                    <p className="hint hint--small">
                      {c.rulesetVersion} · {c.moveCap} moves · {c.status === "open" ? "Open" : "Closed"} ·{" "}
                      {attemptLabel(c)}
                    </p>
                  </div>
                  {canStart &&
                    (resumable || confirm === c.id ? (
                      <button
                        type="button"
                        className="button button--primary button--small"
                        disabled={busy !== null}
                        onClick={() => void start(c)}
                      >
                        {busy === c.id
                          ? "Opening…"
                          : resumable
                            ? "Resume attempt"
                            : "Confirm: start official attempt"}
                      </button>
                    ) : (
                      <button type="button" className="button button--small" onClick={() => setConfirm(c.id)}>
                        Start attempt…
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
