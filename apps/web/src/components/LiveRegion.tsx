import { useEffect, useState } from "react";
import type { Announcer } from "../a11y/announcer.js";

/**
 * Single polite live region fed by the throttled Announcer. Alternating a trailing no-break space lets
 * an identical consecutive message be spoken again.
 */
export function LiveRegion({ announcer }: { announcer: Announcer }) {
  const [state, setState] = useState({ text: "", flip: false });
  useEffect(() => announcer.subscribe((text) => setState((s) => ({ text, flip: !s.flip }))), [announcer]);
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="live-region">
      {state.text ? `${state.text}${state.flip ? " " : ""}` : ""}
    </div>
  );
}
