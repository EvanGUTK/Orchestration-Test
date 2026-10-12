import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { Decimal } from "@g2048/contracts";
import { formatScore } from "../lib/format.js";

/** Exact score display: grouped decimal when short, truncated scientific form + "Show exact" when long. */
export function ScoreDisplay({ label, value }: { label: string; value: Decimal }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const score = formatScore(value);
  return (
    <div className="stat" data-truncated={score.truncated}>
      <span className="stat__label" id={`${id}-label`}>
        {label}
      </span>
      <output
        className="stat__value"
        aria-labelledby={`${id}-label`}
        title={score.truncated ? score.exact : undefined}
      >
        {score.truncated && !expanded ? (
          <>
            <span aria-hidden="true">{score.short}</span>
            <span className="visually-hidden">{score.spoken}</span>
          </>
        ) : (
          <span className="stat__exact">{score.truncated ? score.exact : score.short}</span>
        )}
      </output>
      {score.truncated && (
        <button
          type="button"
          className="link-button"
          aria-expanded={expanded}
          aria-label={expanded ? "Show compact score" : `Show all ${score.digits} digits`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Compact" : "Exact"}
        </button>
      )}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  );
}
