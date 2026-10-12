import { useCallback, useEffect, useState } from "react";
import type { GameSummary } from "@g2048/contracts";
import { describeApiError } from "../api/client.js";
import { navigate, routeHref } from "../app/routes.js";
import { useAuth, useGameSnapshot, useServices, useSettings } from "../app/services.js";
import { TileText } from "../components/Tile.js";
import type { ServerGameAdapter } from "../game/server-adapter.js";
import { formatScore } from "../lib/format.js";
import { sessionTitle } from "./PlayScreen.js";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      items: GameSummary[];
      nextCursor: string | null;
      loadingMore: boolean;
      moreError: string | null;
    };

const PAGE_SIZE = 20;

function modeLabel(game: GameSummary): string {
  return game.mode === "practice"
    ? "Custom practice"
    : game.mode === "classic"
      ? "Classic infinite"
      : game.mode;
}

function statusLabel(status: GameSummary["status"]): string {
  return status === "active" ? "In progress" : status === "completed" ? "Finished" : "Ended early";
}

function AccountSaves() {
  const { api, serverGame } = useServices();
  const settings = useSettings();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    try {
      const page = await api.listGames(null, PAGE_SIZE);
      setList({
        kind: "ready",
        items: page.items,
        nextCursor: page.nextCursor,
        loadingMore: false,
        moreError: null,
      });
    } catch (error) {
      setList({ kind: "error", message: describeApiError(error) });
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    api.listGames(null, PAGE_SIZE).then(
      (page) => {
        if (!cancelled)
          setList({
            kind: "ready",
            items: page.items,
            nextCursor: page.nextCursor,
            loadingMore: false,
            moreError: null,
          });
      },
      (error: unknown) => {
        if (!cancelled) setList({ kind: "error", message: describeApiError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const loadMore = async () => {
    if (list.kind !== "ready" || !list.nextCursor) return;
    setList({ ...list, loadingMore: true, moreError: null });
    try {
      const page = await api.listGames(list.nextCursor, PAGE_SIZE);
      setList((prev) =>
        prev.kind === "ready"
          ? {
              kind: "ready",
              // Cursor pages never overlap, but guard against duplicates if a game moved between pages.
              items: [...prev.items, ...page.items.filter((g) => !prev.items.some((p) => p.id === g.id))],
              nextCursor: page.nextCursor,
              loadingMore: false,
              moreError: null,
            }
          : prev,
      );
    } catch (error) {
      setList((prev) =>
        prev.kind === "ready" ? { ...prev, loadingMore: false, moreError: describeApiError(error) } : prev,
      );
    }
  };

  const open = async (id: string) => {
    setOpening(id);
    setOpenError(null);
    try {
      await serverGame.load((adapter) => (adapter as ServerGameAdapter).open(id));
      navigate("play");
    } catch (error) {
      setOpenError(`Couldn't open that game. ${describeApiError(error)}`);
    } finally {
      setOpening(null);
    }
  };

  return (
    <section className="panel" aria-labelledby="account-saves-title" aria-busy={list.kind === "loading"}>
      <h2 className="panel__title" id="account-saves-title">
        Your saved games
      </h2>
      {list.kind === "loading" && <p role="status">Loading saved games…</p>}
      {list.kind === "error" && (
        <div className="notice notice--error" role="alert">
          <p>Couldn't load your saved games. {list.message}</p>
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              setList({ kind: "loading" });
              void loadFirst();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {list.kind === "ready" && list.items.length === 0 && (
        <div>
          <p>No saved games yet. Start one — it is saved on the server after every move.</p>
          <a className="button button--primary" href={routeHref("play")}>
            Start a game
          </a>
        </div>
      )}
      {openError && (
        <p className="notice notice--error" role="alert">
          {openError}
        </p>
      )}
      {list.kind === "ready" && list.items.length > 0 && (
        <>
          <ul className="save-list">
            {list.items.map((g) => (
              <li key={g.id} className="save-row">
                <div>
                  <p className="save-row__title">
                    {modeLabel(g)} <span className="hint hint--small">({g.rulesetVersion})</span>
                  </p>
                  <p className="hint hint--small">
                    {statusLabel(g.status)} · Score {formatScore(g.score).short} · {g.acceptedMoves} moves
                    {g.maxExponent && (
                      <>
                        {" "}
                        · Top <TileText exponent={g.maxExponent} style={settings.tileDisplay} />
                      </>
                    )}{" "}
                    · Updated {new Date(g.updatedAt).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  className="button button--small"
                  disabled={opening !== null}
                  aria-label={`${g.status === "active" ? "Resume" : "View"} ${modeLabel(g)} game, score ${formatScore(g.score).spoken}`}
                  onClick={() => void open(g.id)}
                >
                  {opening === g.id ? "Opening…" : g.status === "active" ? "Resume" : "View"}
                </button>
              </li>
            ))}
          </ul>
          {list.moreError && (
            <p className="notice notice--error" role="alert">
              Couldn't load more. {list.moreError}
            </p>
          )}
          {list.nextCursor && (
            <button
              type="button"
              className="button"
              disabled={list.loadingMore}
              onClick={() => void loadMore()}
            >
              {list.loadingMore ? "Loading…" : list.moreError ? "Try loading more again" : "Load more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function GuestSave() {
  const { localGame } = useServices();
  const { session } = useGameSnapshot(localGame);
  const [confirming, setConfirming] = useState(false);
  if (!localGame) return null;
  return (
    <section className="panel" aria-labelledby="guest-save-title">
      <h2 className="panel__title" id="guest-save-title">
        This browser (guest)
      </h2>
      {session ? (
        <div className="save-row">
          <div>
            <p className="save-row__title">{sessionTitle(session)}</p>
            <p className="hint hint--small">
              Score {formatScore(session.state.score).short} · {session.state.acceptedMoves} moves ·{" "}
              {session.state.status === "active" ? "in progress" : "finished"}
            </p>
          </div>
          <div className="action-row">
            <button type="button" className="button button--primary" onClick={() => navigate("play")}>
              Resume
            </button>
            {confirming ? (
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  setConfirming(false);
                  void localGame.discard();
                }}
              >
                Confirm discard
              </button>
            ) : (
              <button type="button" className="button button--ghost" onClick={() => setConfirming(true)}>
                Discard…
              </button>
            )}
          </div>
        </div>
      ) : (
        <p>No guest game saved in this browser. Start one and it is saved after every move.</p>
      )}
    </section>
  );
}

export function SavesScreen() {
  const auth = useAuth();
  if (auth.status === "signed-in") {
    return (
      <div className="stack">
        <AccountSaves />
        <p className="hint hint--small">
          Guest games from this browser stay separate from your account. Sign out to see them.
        </p>
      </div>
    );
  }
  return (
    <div className="stack">
      <GuestSave />
      <section className="panel" aria-labelledby="account-saves-title">
        <h2 className="panel__title" id="account-saves-title">
          Account saves
        </h2>
        <p>
          {auth.status === "offline"
            ? "The local server isn't reachable, so account saves can't be shown right now."
            : "Signed-in players keep any number of games on the local server, resumable after a browser or server restart."}
        </p>
        <a className="button" href={routeHref("welcome")}>
          {auth.status === "offline" ? "Check the server" : "Sign in"}
        </a>
      </section>
    </div>
  );
}
