import type { Direction } from "@g2048/contracts";

const BUTTONS: Array<{ direction: Direction; label: string; glyph: string }> = [
  { direction: "up", label: "Move up", glyph: "↑" },
  { direction: "left", label: "Move left", glyph: "←" },
  { direction: "down", label: "Move down", glyph: "↓" },
  { direction: "right", label: "Move right", glyph: "→" },
];

/** On-screen controls (>= 48px targets) for touch, switch and pointer users. */
export function DirectionPad({ onMove, disabled }: { onMove: (d: Direction) => void; disabled?: boolean }) {
  return (
    <div className="dpad" role="group" aria-label="Move tiles">
      {BUTTONS.map((b) => (
        <button
          key={b.direction}
          type="button"
          className={`dpad__btn dpad__btn--${b.direction}`}
          aria-label={b.label}
          disabled={disabled}
          onClick={() => onMove(b.direction)}
        >
          <span aria-hidden="true">{b.glyph}</span>
        </button>
      ))}
    </div>
  );
}
