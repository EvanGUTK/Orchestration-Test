import { useState } from "react";
import { navigate } from "../app/routes.js";
import { useGameSnapshot, useServices } from "../app/services.js";
import { formatScore } from "../lib/format.js";
import { EngineUnavailable, sessionTitle } from "./PlayScreen.js";

export function SavesScreen() {
  const { game } = useServices();
  const { session } = useGameSnapshot(game);
  const [confirming, setConfirming] = useState(false);

  if (!game) return <EngineUnavailable />;

  return (
    <div className="stack">
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
                    void game.discard();
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
      <section className="panel panel--unavailable" aria-labelledby="account-saves-title">
        <h2 className="panel__title" id="account-saves-title">
          Account saves
        </h2>
        <p className="badge badge--pending">Not available yet</p>
        <p>
          Signed-in players keep any number of saves on the local server, resumable after a browser or server
          restart. The server connection is not part of this build yet.
        </p>
      </section>
    </div>
  );
}
