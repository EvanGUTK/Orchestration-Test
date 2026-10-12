import { useId, useRef, useState } from "react";
import { RULESETS } from "@g2048/contracts";
import type { Direction, GameState } from "@g2048/contracts";
import { describeApiError, isApiError } from "../api/client.js";
import { routeHref } from "../app/routes.js";
import { useActiveGame, useAuth, useGameSnapshot, useServices, useSettings } from "../app/services.js";
import { Board } from "../components/Board.js";
import { Dialog } from "../components/Dialog.js";
import { DirectionPad } from "../components/DirectionPad.js";
import { ScoreDisplay, Stat } from "../components/ScoreDisplay.js";
import { TileText } from "../components/Tile.js";
import { Unavailable } from "../components/Unavailable.js";
import type { GameSession } from "../game/adapter.js";
import type { GameController, GameSnapshot } from "../game/controller.js";
import { describeKey } from "../input/keyboard.js";

export function highestExponent(state: GameState): string | null {
  let best: bigint | null = null;
  for (const cell of state.board.cells) {
    if (cell === null) continue;
    const e = BigInt(cell);
    if (best === null || e > best) best = e;
  }
  return best === null ? null : best.toString();
}

export function sessionTitle(session: { mode: string; rules: { size: number } }): string {
  const size = `${session.rules.size}×${session.rules.size}`;
  return session.mode === "practice" ? `Custom practice · ${size}` : `Classic infinite · ${size}`;
}

export function EngineUnavailable() {
  return (
    <Unavailable
      purpose="Guest play runs the deterministic 2048 engine right here in your browser, with no network."
      reason="The game engine is not available in this build. Sign in to play on the local server instead."
      alternatives={[
        { to: "welcome", label: "Sign in" },
        { to: "settings", label: "Adjust settings" },
      ]}
    />
  );
}

/** Recovery actions for a failed command, specific to the error (UI-05). */
function GameProblem({ game, snapshot }: { game: GameController; snapshot: GameSnapshot }) {
  const { stalled, errorCode, notice } = snapshot;
  if (stalled) {
    return (
      <div className="notice notice--warn" role="alert">
        <p>
          <strong>Connection problem.</strong> {stalled.message}{" "}
          {stalled.waiting === 1 ? "1 move is" : `${stalled.waiting} moves are`} waiting and will be sent in
          order — none are lost or sent twice.
        </p>
        <div className="action-row">
          <button
            type="button"
            className="button button--primary button--small"
            onClick={() => game.retryStalled()}
          >
            Retry now
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void game.discardStalled()}
          >
            Discard waiting moves
          </button>
        </div>
      </div>
    );
  }
  if (!notice) return null;
  return (
    <div className="notice" role="status">
      <p>{notice}</p>
      {errorCode === "UNAUTHENTICATED" && (
        <a className="button button--primary button--small" href={routeHref("welcome")}>
          Sign in again
        </a>
      )}
      {(errorCode === "REVISION_CONFLICT" ||
        errorCode === "IDEMPOTENCY_CONFLICT" ||
        errorCode === "BAD_RESPONSE") && (
        <button type="button" className="button button--small" onClick={() => void game.reload()}>
          Reload game
        </button>
      )}
    </div>
  );
}

export function PlayScreen() {
  const { announcer } = useServices();
  const auth = useAuth();
  const game = useActiveGame();
  const settings = useSettings();
  const snapshot = useGameSnapshot(game);
  const boardRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  if (!game) return <EngineUnavailable />;
  const signedIn = auth.status === "signed-in";
  const { session, lastMove, celebrating } = snapshot;

  const startGame = async (request: Parameters<GameController["start"]>[0]) => {
    setStarting(true);
    setStartError(null);
    try {
      await game.start(request);
      boardRef.current?.focus();
    } catch (error) {
      setStartError(
        isApiError(error) && error.code === "NOT_FOUND"
          ? `This server doesn't offer account games yet (request ${error.requestId ?? "unknown"}).`
          : `Couldn't start a game. ${describeApiError(error)}`,
      );
    } finally {
      setStarting(false);
    }
  };

  if (!session) {
    return (
      <section className="panel" aria-label="Start a game" aria-busy={starting}>
        <p className="lede">
          {signedIn
            ? `No game open. Games for ${auth.user.displayName} are saved on the local server after every move.`
            : "No game in progress. Your guest game is saved in this browser after every move."}
        </p>
        {startError && (
          <p className="notice notice--error" role="alert">
            {startError}
          </p>
        )}
        <div className="action-row">
          <button
            type="button"
            className="button button--primary"
            disabled={starting}
            onClick={() => void startGame({ mode: "classic", rules: RULESETS["classic-v1"] })}
          >
            {starting ? "Starting…" : startError ? "Try again" : "Start classic game"}
          </button>
          <a className="button button--ghost" href={routeHref("practice")}>
            Custom practice
          </a>
          {signedIn && (
            <a className="button button--ghost" href={routeHref("saves")}>
              Resume a saved game
            </a>
          )}
        </div>
      </section>
    );
  }

  const { state, rules } = session as GameSession;
  const active = state.status === "active";
  const top = highestExponent(state);
  const move = (direction: Direction, repeat = false) => game.move(direction, { repeat });
  const keys = (d: Direction) => settings.keyBindings[d].map(describeKey).join("/");
  const newGame = () => void startGame({ mode: session.mode, rules: session.rules });

  return (
    <div className="play">
      <div className="play__header">
        <p className="eyebrow">
          {sessionTitle(session)} ·{" "}
          {session.authority === "server" ? "saved on server" : "guest, this browser"}
        </p>
        <div className="stats">
          <ScoreDisplay label="Score" value={state.score} />
          <Stat label="Moves" value={String(state.acceptedMoves)} />
          <Stat label="Top" value={top ? <TileText exponent={top} style={settings.tileDisplay} /> : "—"} />
        </div>
      </div>

      <div className="play__board">
        <Board
          boardRef={boardRef}
          board={state.board}
          tileStyle={settings.tileDisplay}
          bindings={settings.keyBindings}
          lastMove={lastMove}
          onMove={move}
          label={`${rules.size} by ${rules.size} game board`}
          describedBy={helpId}
        />
        {!active && (
          <div className="board-overlay" role="status">
            <p className="board-overlay__title">
              {state.status === "forfeited" ? "Game ended" : "No moves left"}
            </p>
            <div className="action-row">
              <button type="button" className="button button--primary" onClick={newGame} disabled={starting}>
                New game
              </button>
              {session.canUndo && (
                <button type="button" className="button button--ghost" onClick={() => game.undo()}>
                  Undo last move
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <p id={helpId} className="hint">
        Click or tab to the board, then use {keys("up")}, {keys("left")}, {keys("down")}, {keys("right")} — or
        swipe, or use the buttons below.
      </p>
      <GameProblem game={game} snapshot={snapshot} />
      {startError && (
        <p className="notice notice--error" role="alert">
          {startError}
        </p>
      )}

      <DirectionPad onMove={(d) => move(d)} disabled={!active || celebrating} />

      <div className="action-row action-row--center">
        <button type="button" className="button" onClick={newGame} disabled={starting}>
          New game
        </button>
        {rules.undo && (
          <button
            type="button"
            className="button"
            onClick={() => game.undo()}
            disabled={!session.canUndo}
            aria-describedby={`${helpId}-undo`}
          >
            Undo
          </button>
        )}
        {active &&
          (confirmEnd ? (
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                setConfirmEnd(false);
                game.forfeit();
              }}
            >
              Confirm: end game
            </button>
          ) : (
            <button type="button" className="button button--ghost" onClick={() => setConfirmEnd(true)}>
              End game…
            </button>
          ))}
        <button
          type="button"
          className="button button--ghost"
          onClick={() => announcer.announce(game.describeBoard(), "important")}
        >
          Read board aloud
        </button>
      </div>
      {rules.undo && (
        <p className="hint hint--small" id={`${helpId}-undo`}>
          {session.undoDepth === null
            ? `Undo keeps up to ${rules.historyLimit} moves on the server.`
            : `${session.undoDepth} of up to ${rules.historyLimit} undo steps available (kept for this browser tab only).`}
        </p>
      )}
      {session.seed && (
        <p className="hint hint--small">
          Seed <code className="seed">{session.seed}</code>
        </p>
      )}

      {celebrating && (
        <Dialog
          title="You made 2048!"
          onDismiss={() => game.keepPlaying()}
          actions={
            <button type="button" className="button button--primary" onClick={() => game.keepPlaying()}>
              Keep playing
            </button>
          }
        >
          <p>There is no ceiling in 2048 Infinite. Your run continues — see how far the exponents go.</p>
        </Dialog>
      )}
    </div>
  );
}
