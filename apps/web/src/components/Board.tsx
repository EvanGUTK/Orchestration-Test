import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { Board as BoardData, Direction, Preferences } from "@2048/contracts";
import { directionForKey } from "../input/keys.ts";
import { classifySwipe } from "../input/swipe.ts";
import { tileLabel, tileSpoken } from "../format.ts";
import type { TileView } from "../game/tiles.ts";

export function exponentLevel(exponent: string): { level: number; hue: number } {
  const e = BigInt(exponent);
  if (e <= 12n) return { level: Number(e), hue: 0 };
  return { level: 13, hue: Number((e * 37n) % 360n) };
}

function labelClass(label: string): string {
  const n = label.length;
  if (n <= 2) return "len-s";
  if (n <= 4) return "len-m";
  if (n <= 6) return "len-l";
  if (n <= 8) return "len-xl";
  if (n <= 9) return "len-xxl";
  return "len-xxxl";
}

type BoardProps = {
  board: BoardData;
  tiles: readonly TileView[];
  tileStyle: Preferences["tileStyle"];
  keyBindings: Preferences["keyBindings"];
  onMove?: (direction: Direction) => void;
  label: string;
  /** Read-only boards (opponent, replay) take no input and are not focusable. */
  interactive?: boolean;
  dimmed?: boolean;
};

export function BoardView(props: BoardProps) {
  const { board, tiles, tileStyle, keyBindings, onMove, label, interactive = true, dimmed = false } = props;
  const size = board.size;
  const gesture = useRef<{ x: number; y: number; t: number; id: number } | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !onMove) return;
    // Handler is attached to the board element, so it only runs while the board itself has focus.
    const direction = directionForKey(event.nativeEvent, keyBindings);
    if (direction === null) return;
    event.preventDefault();
    onMove(direction);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || event.button > 0) return;
    gesture.current = { x: event.clientX, y: event.clientY, t: event.timeStamp, id: event.pointerId };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    gesture.current = null;
    if (!interactive || !onMove || !start || start.id !== event.pointerId) return;
    const direction = classifySwipe(event.clientX - start.x, event.clientY - start.y, event.timeStamp - start.t);
    if (direction) onMove(direction);
  };
  const onPointerCancel = () => {
    gesture.current = null;
  };

  const rows: number[] = Array.from({ length: size }, (_, i) => i);

  return (
    <div
      className={`board${dimmed ? " board-dimmed" : ""}`}
      style={{ ["--size" as string]: size }}
      tabIndex={interactive ? 0 : -1}
      role="group"
      aria-roledescription="game board"
      aria-label={label}
      data-interactive={interactive ? "true" : "false"}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-testid="board"
    >
      <div className="board-grid" aria-hidden="true">
        {board.cells.map((_, i) => (
          <div className="board-cell" key={i} />
        ))}
      </div>
      <div className="board-tiles" aria-hidden="true">
        {tiles.map((tile) => {
          const text = tileLabel(tile.exponent, tileStyle);
          const { level, hue } = exponentLevel(tile.exponent);
          const pattern = Number(BigInt(tile.exponent) % 6n);
          return (
            <div
              key={tile.id}
              className={`tile${tile.fresh ? " tile-fresh" : ""}${tile.merged ? " tile-merged" : ""}${tile.leaving ? " tile-leaving" : ""}`}
              style={{
                ["--x" as string]: tile.index % size,
                ["--y" as string]: Math.floor(tile.index / size),
                ["--hue" as string]: hue,
              }}
              data-level={level}
              data-pattern={pattern}
              data-exponent={tile.exponent}
            >
              <div className={`tile-face ${labelClass(text)}`}>
                <span className="tile-text">{text}</span>
              </div>
            </div>
          );
        })}
      </div>
      {/* Equivalent text for assistive technology; not announced per frame, only read on demand. */}
      <div className="sr-only">
        <table aria-label={`${label} contents`}>
          <tbody>
            {rows.map((row) => (
              <tr key={row}>
                {board.cells.slice(row * size, row * size + size).map((cell, col) => (
                  <td key={col}>{cell === null ? "empty" : tileSpoken(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
