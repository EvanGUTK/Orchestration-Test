import { useId, useRef } from "react";
import { RULESETS } from "@g2048/contracts";
import type { Direction, GameState } from "@g2048/contracts";
import { routeHref } from "../app/routes.js";
import { useGameSnapshot, useServices, useSettings } from "../app/services.js";
import { Board } from "../components/Board.js";
import { Dialog } from "../components/Dialog.js";
import { DirectionPad } from "../components/DirectionPad.js";
import { ScoreDisplay, Stat } from "../components/ScoreDisplay.js";
import { TileText } from "../components/Tile.js";
import { Unavailable } from "../components/Unavailable.js";
import type { GameSession } from "../game/adapter.js";
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

export function sessionTitle(session: GameSession): string {
  const size = `${session.rules.size}×${session.rules.size}`;
  return session.mode === "practice" ? `Custom practice · ${size}` : `Classic infinite · ${size}`;
}

export function EngineUnavailable() {
  return (
    <Unavailable
      purpose="Guest play runs the deterministic 2048 engine right here in your browser, with no network."
      reason="The game engine has not been integrated into this build yet. This screen switches to a playable board automatically once it is."
      alternatives={[
        { to: "settings", label: "Adjust settings" },
        { to: "modes", label: "See all modes" },
      ]}
    />
  );
}

export function PlayScreen() {
  const { game, announcer } = useServices();
  const settings = useSettings();
  const snapshot = useGameSnapshot(game);
  const boardRef = useRef<HTMLDivElement>(null);
  const helpId = useId();

  if (!game) return <EngineUnavailable />;
  const { session, lastMove, celebrating, notice } = snapshot;

  const startClassic = async () => {
    await game.start({ mode: "classic", rules: RULESETS["classic-v1"] });
    boardRef.current?.focus();
  };

  if (!session) {
    return (
      <section className="panel" aria-label="Start a game">
        <p className="lede">
          No game in progress. Your guest game is saved in this browser after every move.
        </p>
        <div className="action-row">
          <button type="button" className="button button--primary" onClick={() => void startClassic()}>
            Start classic game
          </button>
          <a className="button button--ghost" href={routeHref("practice")}>
            Custom practice
          </a>
        </div>
      </section>
    );
  }

  const { state, rules } = session;
  const active = state.status === "active";
  const top = highestExponent(state);
  const move = (direction: Direction, repeat = false) => game.move(direction, { repeat });
  const keys = (d: Direction) => settings.keyBindings[d].map(describeKey).join("/");
  const newGame = async () => {
    await game.start({ mode: session.mode, rules: session.rules });
    boardRef.current?.focus();
  };

  return (
    <div className="play">
      <div className="play__header">
        <p className="eyebrow">{sessionTitle(session)}</p>
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
              {state.status === "forfeited" ? "Game forfeited" : "No moves left"}
            </p>
            <div className="action-row">
              <button type="button" className="button button--primary" onClick={() => void newGame()}>
                New game
              </button>
              {rules.undo && session.undoDepth > 0 && (
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
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <DirectionPad onMove={(d) => move(d)} disabled={!active || celebrating} />

      <div className="action-row action-row--center">
        <button type="button" className="button" onClick={() => void newGame()}>
          New game
        </button>
        {rules.undo && (
          <button
            type="button"
            className="button"
            onClick={() => game.undo()}
            disabled={session.undoDepth === 0}
            aria-describedby={`${helpId}-undo`}
          >
            Undo
          </button>
        )}
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
          {session.undoDepth} of up to {rules.historyLimit} undo steps available (kept for this browser tab
          only).
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
