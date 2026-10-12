import type { ReactNode } from "react";
import { routeHref } from "../app/routes.js";
import type { RouteId } from "../app/routes.js";

type UnavailableProps = {
  /** What this screen will do once it is available. */
  purpose: string;
  /** Why it is not available in this build. */
  reason: string;
  /** Concrete things the player can do instead. */
  alternatives?: Array<{ to: RouteId; label: string }>;
  children?: ReactNode;
};

/**
 * Honest "not available yet" state. Shows no sample rankings, numbers, or placeholder players.
 */
export function Unavailable({ purpose, reason, alternatives = [], children }: UnavailableProps) {
  return (
    <section className="panel panel--unavailable" aria-labelledby="unavailable-status">
      <p className="badge badge--pending" id="unavailable-status">
        Not available yet
      </p>
      <p className="lede">{purpose}</p>
      <p>{reason}</p>
      {children}
      {alternatives.length > 0 && (
        <ul className="action-row" aria-label="What you can do now">
          {alternatives.map((a) => (
            <li key={a.to}>
              <a className="button button--ghost" href={routeHref(a.to)}>
                {a.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
