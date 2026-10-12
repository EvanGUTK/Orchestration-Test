import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Direction } from "@2048/contracts";
import { BoardView } from "./Board.tsx";
import { ErrorPanel } from "./common.tsx";
import { groupDecimal, maxExponentOf, tileLabel } from "../format.ts";
import { describeState, useAnnouncement, useControllerSnapshot } from "../game/hooks.ts";
import type { GameController } from "../game/controller.ts";
import { useApp } from "../state/app.tsx";

const ARROWS: Record<Direction, string> = { up: "↑", right: "→", down: "↓", left: "←" };
const ORDER: Direction[] = ["up", "left", "down", "right"];

export function ScoreCard(props: { label: string; value: string; title?: string }) {
  return (
    <div className="score-card">
      <span className="score-label">{props.label}</span>
      <span className="score-value" title={props.title ?? props.value}>
        {props.value}
      </span>
    </div>
  );
}

export type GamePlayProps = {
  controller: GameController;
  label: string;
  interactive?: boolean;
  actions?: ReactNode;
  statusNote?: ReactNode;
  showUndo?: boolean;
  showPad?: boolean;
  onFinished?: () => void;
  moveCap?: number | null;
};

/** Board + score + live announcements + 2048 celebration + game-over/error states for one controller. */
export function GamePlay(props: GamePlayProps) {
  const { controller, label, interactive = true, actions, statusNote, showUndo = false, showPad = true, moveCap } = props;
  const { prefs } = useApp();
  const snapshot = useControllerSnapshot(controller);
  const announcement = useAnnouncement(snapshot);
  const boardWrap = useRef<HTMLDivElement>(null);
  const { state, tiles } = snapshot;
  const max = maxExponentOf(state.board.cells);
  const over = state.status !== "active";

  const finishedRef = useRef(props.onFinished);
  finishedRef.current = props.onFinished;
  useEffect(() => {
    if (over) finishedRef.current?.();
  }, [over]);

  const move = (direction: Direction) => {
    controller.enqueue(direction);
  };

  return (
    <section className="game" aria-label={label}>
      <div className="score-row">
        <ScoreCard label="Score" value={groupDecimal(state.score)} title={state.score} />
        <ScoreCard label="Best tile" value={max === null ? "-" : tileLabel(max, prefs.tileStyle)} />
        <ScoreCard
          label={moveCap ? "Moves (cap)" : "Moves"}
          value={moveCap ? `${state.acceptedMoves} / ${moveCap}` : String(state.acceptedMoves)}
        />
      </div>

      <div className="board-wrap" ref={boardWrap}>
        <BoardView
          board={state.board}
          tiles={tiles}
          tileStyle={prefs.tileStyle}
          keyBindings={prefs.keyBindings}
          label={label}
          interactive={interactive && !over}
          onMove={move}
          dimmed={over || snapshot.celebrate}
        />
        {snapshot.celebrate ? (
          <div className="overlay" role="dialog" aria-modal="false" aria-label="You reached 2048">
            <h2>You made 2048!</h2>
            <p>There is no ceiling. The run keeps going.</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                controller.dismissCelebration();
                boardWrap.current?.querySelector<HTMLElement>("[data-testid=board]")?.focus();
              }}
            >
              Keep playing
            </button>
          </div>
        ) : null}
        {over ? (
          <div className="overlay" role="status">
            <h2>{state.status === "forfeited" ? "Forfeited" : moveCap && state.acceptedMoves >= moveCap ? "Move cap reached" : "Game over"}</h2>
            <p>Final score {groupDecimal(state.score)}</p>
          </div>
        ) : null}
      </div>

      {state.score.length > 15 ? (
        <details className="exact">
          <summary>Exact score ({state.score.length} digits)</summary>
          <code data-testid="exact-score">{state.score}</code>
        </details>
      ) : null}

      <p className="visually-subtle" id="board-help">
        Focus the board, then use arrow keys or WASD. Swipe on touch screens.
      </p>

      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="announcer">
        {announcement}
      </div>
      <p className="sr-only">{describeState(state)}</p>

      {snapshot.error !== null ? (
        <ErrorPanel
          error={snapshot.error}
          onRetry={() => controller.retry()}
          retryLabel="Retry last move"
          extra={
            <button type="button" className="btn" onClick={() => void controller.reload()}>
              Reload latest game state
            </button>
          }
        />
      ) : null}

      {showPad && !over ? (
        <div className="pad" role="group" aria-label="Move buttons">
          {ORDER.map((direction) => (
            <button
              key={direction}
              type="button"
              className={`btn pad-${direction}`}
              aria-label={`Move ${direction}`}
              disabled={!interactive}
              onClick={() => move(direction)}
            >
              <span aria-hidden="true">{ARROWS[direction]}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="row game-actions">
        {showUndo ? (
          <button
            type="button"
            className="btn"
            disabled={snapshot.undoAvailable <= 0 || snapshot.syncing || snapshot.pending > 0}
            onClick={() => void controller.undo()}
          >
            Undo ({snapshot.undoAvailable})
          </button>
        ) : null}
        {actions}
      </div>
      <p className="muted status-note" aria-live="off">
        {snapshot.syncing ? "Syncing with the local server..." : snapshot.pending > 0 ? `${snapshot.pending} move(s) queued` : statusNote}
      </p>
    </section>
  );
}
