import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type VirtualListProps = {
  count: number;
  rowHeight: number;
  /** Visible viewport height in px. */
  height: number;
  label: string;
  activeIndex?: number;
  overscan?: number;
  renderRow: (index: number) => ReactNode;
};

/**
 * Windowed list: only the rows in (and just around) the viewport are in the DOM, so a 200,000-move
 * replay renders a few dozen elements. Rows carry aria-setsize/aria-posinset so assistive tech still
 * knows the list size and each row's position.
 */
export function VirtualList({
  count,
  rowHeight,
  height,
  label,
  activeIndex,
  overscan = 6,
  renderRow,
}: VirtualListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Keep the active row in view when it changes (playback, seeking).
  useEffect(() => {
    const el = ref.current;
    if (!el || activeIndex === undefined || activeIndex < 0) return;
    const top = activeIndex * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + height) el.scrollTop = top + rowHeight - height;
  }, [activeIndex, rowHeight, height]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <li
        key={i}
        className="vlist__row"
        style={{ top: i * rowHeight, height: rowHeight }}
        aria-setsize={count}
        aria-posinset={i + 1}
        data-index={i}
      >
        {renderRow(i)}
      </li>,
    );
  }

  return (
    <div
      ref={ref}
      className="vlist"
      style={{ height }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      tabIndex={-1}
    >
      <ul className="vlist__inner" aria-label={label} style={{ height: count * rowHeight }}>
        {rows}
      </ul>
    </div>
  );
}
