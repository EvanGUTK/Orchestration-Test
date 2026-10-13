import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { LeaderboardEntry, LeaderboardScope } from "@g2048/contracts";
import { describeApiError } from "../api/client.js";
import { useServices, useSettings } from "../app/services.js";
import { TileText } from "../components/Tile.js";
import { Unavailable } from "../components/Unavailable.js";
import { formatScore } from "../lib/format.js";
import { isUnavailable } from "../ranking/source.js";
import type { LeaderboardFilters } from "../ranking/source.js";

const SCOPES: Array<{ scope: LeaderboardScope; label: string; about: string }> = [
  {
    scope: "casual",
    label: "Casual best",
    about: "Best classic scores. Practice and bot games are never included.",
  },
  {
    scope: "challenge",
    label: "Challenges",
    about: "Official ranked-challenge attempts: score, then top tile, then earliest attempt.",
  },
  {
    scope: "duel-elo",
    label: "Duel Elo",
    about: "Human 1v1 ratings (start 1000, K=24). Bots never change human ratings.",
  },
  {
    scope: "bot-league",
    label: "Bot league",
    about: "Bot exhibitions and bot-vs-bot results, separate from people.",
  },
];

type ListState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: LeaderboardEntry[]; next: string | null; more: "idle" | "loading" | string };

const PAGE = 25;

export function LeaderboardsScreen() {
  const { ranking } = useServices();
  const settings = useSettings();
  const id = useId();
  const [scope, setScope] = useState<LeaderboardScope>("casual");
  const [draft, setDraft] = useState({ ruleset: "", season: "", challenge: "", account: "" });
  const [filters, setFilters] = useState<LeaderboardFilters>({ scope: "casual" });
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    ranking.leaderboard(filters, null, PAGE).then(
      (page) => {
        if (!cancelled) setList({ kind: "ready", items: page.items, next: page.nextCursor, more: "idle" });
      },
      (error: unknown) => {
        if (cancelled) return;
        setList(
          isUnavailable(error)
            ? { kind: "unavailable" }
            : { kind: "error", message: describeApiError(error) },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ranking, filters, reload]);

  const choose = (next: LeaderboardScope) => {
    setScope(next);
    setList({ kind: "loading" });
    setFilters({ ...filters, scope: next });
  };
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setList({ kind: "loading" });
    setFilters({ scope, ...draft });
  };
  const loadMore = async () => {
    if (list.kind !== "ready" || !list.next) return;
    setList({ ...list, more: "loading" });
    try {
      const page = await ranking.leaderboard(filters, list.next, PAGE);
      setList((prev) =>
        prev.kind === "ready"
          ? { kind: "ready", items: [...prev.items, ...page.items], next: page.nextCursor, more: "idle" }
          : prev,
      );
    } catch (error) {
      setList((prev) => (prev.kind === "ready" ? { ...prev, more: describeApiError(error) } : prev));
    }
  };

  const info = SCOPES.find((s) => s.scope === scope)!;
  const showRating = scope === "duel-elo";

  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label="Leaderboard">
        {SCOPES.map((s) => (
          <button
            key={s.scope}
            type="button"
            role="tab"
            id={`${id}-tab-${s.scope}`}
            aria-selected={scope === s.scope}
            aria-controls={`${id}-panel`}
            className="tabs__tab"
            onClick={() => choose(s.scope)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <section
        className="panel"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${scope}`}
        aria-busy={list.kind === "loading"}
      >
        <p>{info.about}</p>
        <form className="field-grid" onSubmit={apply} aria-label="Filters">
          <div className="field">
            <label htmlFor={`${id}-ruleset`}>Ruleset</label>
            <select
              id={`${id}-ruleset`}
              value={draft.ruleset}
              onChange={(e) => setDraft({ ...draft, ruleset: e.target.value })}
            >
              <option value="">Any</option>
              {["classic-v1", "ranked-v1", "duel-v1", "bot-v1"].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-season`}>Season</label>
            <input
              id={`${id}-season`}
              type="text"
              maxLength={64}
              value={draft.season}
              onChange={(e) => setDraft({ ...draft, season: e.target.value })}
            />
          </div>
          {scope === "challenge" && (
            <div className="field">
              <label htmlFor={`${id}-challenge`}>Challenge ID</label>
              <input
                id={`${id}-challenge`}
                type="text"
                maxLength={64}
                value={draft.challenge}
                onChange={(e) => setDraft({ ...draft, challenge: e.target.value })}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor={`${id}-account`}>Account</label>
            <input
              id={`${id}-account`}
              type="text"
              maxLength={64}
              value={draft.account}
              onChange={(e) => setDraft({ ...draft, account: e.target.value })}
            />
          </div>
          <div className="field field--end">
            <button type="submit" className="button">
              Apply filters
            </button>
          </div>
        </form>

        {list.kind === "loading" && <p role="status">Loading standings…</p>}
        {list.kind === "unavailable" && (
          <Unavailable
            purpose="Standings come from results recorded and verified by the local server."
            reason="This server doesn't provide leaderboards yet. No rankings are shown until real results exist."
            alternatives={[{ to: "play", label: "Play a game" }]}
          />
        )}
        {list.kind === "error" && (
          <div className="notice notice--error" role="alert">
            <p>Couldn't load standings. {list.message}</p>
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setList({ kind: "loading" });
                setReload((n) => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {list.kind === "ready" && list.items.length === 0 && <p>No results for these filters yet.</p>}
        {list.kind === "ready" && list.items.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="standings">
                <caption className="visually-hidden">{info.label} standings</caption>
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Player</th>
                    <th scope="col">{showRating ? "Rating" : "Score"}</th>
                    {!showRating && <th scope="col">Top tile</th>}
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((entry) => {
                    const score = entry.score ? formatScore(entry.score) : null;
                    return (
                      <tr key={`${entry.rank}-${entry.gameId ?? entry.accountId ?? entry.displayName}`}>
                        <td>{entry.rank}</td>
                        <td>
                          {entry.displayName}
                          {entry.botStrategy && <span className="badge"> bot · {entry.botStrategy}</span>}
                          {entry.accountId === null && !entry.botStrategy && (
                            <span className="hint hint--small"> (deleted account)</span>
                          )}
                        </td>
                        <td className="num">
                          {showRating ? (
                            (entry.rating ?? "—")
                          ) : score ? (
                            <span title={score.truncated ? score.exact : undefined}>
                              <span aria-hidden={score.truncated}>{score.short}</span>
                              {score.truncated && <span className="visually-hidden">{score.spoken}</span>}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        {!showRating && (
                          <td>
                            {entry.maxExponent ? (
                              <TileText exponent={entry.maxExponent} style={settings.tileDisplay} />
                            ) : (
                              "—"
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {list.more !== "idle" && list.more !== "loading" && (
              <p className="notice notice--error" role="alert">
                Couldn't load more. {list.more}
              </p>
            )}
            {list.next && (
              <button
                type="button"
                className="button"
                disabled={list.more === "loading"}
                onClick={() => void loadMore()}
              >
                {list.more === "loading" ? "Loading…" : "Load more"}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
