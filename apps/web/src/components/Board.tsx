import { useMemo, useRef } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, Ref } from "react";
import type { Board as BoardModel, Direction } from "@g2048/contracts";
import { deriveTileAnimations } from "../game/animation.js";
import type { LastMove } from "../game/controller.js";
import { directionForKey } from "../input/keyboard.js";
import type { KeyBindings } from "../input/keyboard.js";
import { SwipeTracker } from "../input/swipe.js";
import type { TileDisplayStyle } from "../lib/format.js";
import { Tile } from "./Tile.js";

export type BoardProps = {
  board: BoardModel;
  tileStyle: TileDisplayStyle;
  bindings: KeyBindings;
  lastMove?: LastMove | null;
  /** Called for every recognized key press / swipe while the board has focus. */
  onMove?: (direction: Direction, repeat: boolean) => void;
  label: string;
  describedBy?: string;
  boardRef?: Ref<HTMLDivElement>;
};

/**
 * Renders a 3..8 board from the authoritative Board. Keys are handled only by this focused element,
 * and the browser default (page scroll) is prevented only for keys that are actually bound.
 */
export function Board({
  board,
  tileStyle,
  bindings,
  lastMove,
  onMove,
  label,
  describedBy,
  boardRef,
}: BoardProps) {
  const swipe = useRef<SwipeTracker | null>(null);
  const animations = useMemo(
    () => (lastMove ? deriveTileAnimations(lastMove.events, board.size) : new Map()),
    [lastMove, board.size],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onMove || event.target !== event.currentTarget) return;
    const direction = directionForKey(event, bindings);
    if (!direction) return;
    event.preventDefault();
    onMove(direction, event.repeat);
  };

  const tracker = () => (swipe.current ??= new SwipeTracker());
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    tracker().down(event.pointerId, event.clientX, event.clientY, event.timeStamp);
    event.currentTarget.focus({ preventScroll: true });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const direction = tracker().up(event.pointerId, event.clientX, event.clientY, event.timeStamp);
    if (direction && onMove) onMove(direction, false);
  };

  return (
    <div
      ref={boardRef}
      className="board"
      style={{ "--size": board.size } as CSSProperties}
      tabIndex={0}
      role="application"
      aria-roledescription="game board"
      aria-label={label}
      aria-describedby={describedBy}
      data-size={board.size}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => tracker().cancel()}
    >
      {board.cells.map((cell, index) => {
        const animation = animations.get(index);
        return (
          <div className="cell" key={index} data-index={index}>
            {cell !== null && (
              <Tile
                key={animation && lastMove ? `${lastMove.seq}:${index}` : `still:${index}`}
                exponent={cell}
                style={tileStyle}
                animation={animation}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
