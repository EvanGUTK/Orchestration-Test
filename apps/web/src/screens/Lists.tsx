import { useState } from "react";
import type { FormEvent } from "react";
import type { Challenge, GameView, LeaderboardEntry, LeaderboardKind, Page } from "@2048/contracts";
import { MAX_BOARD_SIZE, MIN_BOARD_SIZE } from "@2048/contracts";
import { challengeItems } from "../api/client.ts";
import { Field, EmptyState, ErrorPanel, PageHeading, Spinner } from "../components/common.tsx";
import { formatDate, groupDecimal, maxExponentOf, tileLabel } from "../format.ts";
import { Link, useNavigate } from "../router.tsx";
import { useApp } from "../state/app.tsx";
import { useStartGame } from "../state/startGame.ts";
import { loadGuestGame } from "../state/guestSave.ts";
import { useAsync } from "../state/useAsync.ts";
import { isEngineAvailable } from "../engine/port.ts";

// --- practice settings -------------------------------------------------------------
export function validatePractice(input: { size: string; fours: string; seed: string }): Record<string, string> {
  const found: Record<string, string> = {};
  const n = Number(input.size);
  if (input.size.trim() === "" || !Number.isInteger(n) || n < MIN_BOARD_SIZE || n > MAX_BOARD_SIZE) {
    found["size"] = `Board size must be a whole number from ${MIN_BOARD_SIZE} to ${MAX_BOARD_SIZE}.`;
  }
  const f = Number(input.fours);
  if (input.fours.trim() === "" || !Number.isInteger(f) || f < 0 || f > 10) found["fours"] = "Enter a whole number from 0 to 10.";
  if (input.seed.length > 64) found["seed"] = "Seed can be at most 64 characters.";
  return found;
}

export function PracticeScreen() {
  const { start, busy, error } = useStartGame();
  const [size, setSize] = useState("4");
  const [seed, setSeed] = useState("");
  const [fours, setFours] = useState("1");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validatePractice({ size, fours, seed });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    await start("practice", { boardSize: Number(size), spawnFourTenths: Number(fours), ...(seed.trim() ? { seed: seed.trim() } : {}) });
  };

  return (
    <>
      <PageHeading title="Custom practice" subtitle="Casual only. Custom games never enter a ranking." />
      <form className="panel form" onSubmit={(e) => void submit(e)} noValidate aria-label="Practice settings">
        <Field id="size" label="Board size" hint="3 to 8 tiles per side." error={errors["size"] ?? null}>
          <input
            id="size"
            inputMode="numeric"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            aria-invalid={errors["size"] ? true : undefined}
            aria-describedby={errors["size"] ? "size-error" : "size-hint"}
          />
        </Field>
        <Field id="seed" label="Seed (optional)" hint="Same seed and moves give the same game. Leave empty for a random one." error={errors["seed"] ?? null}>
          <input id="seed" value={seed} onChange={(e) => setSeed(e.target.value)} spellCheck={false} autoCapitalize="none" aria-describedby="seed-hint" />
        </Field>
        <Field id="fours" label="Chance of a 4 tile (tenths)" hint="0 to 10. 1 means 10 percent fours, the standard rule." error={errors["fours"] ?? null}>
          <input
            id="fours"
            inputMode="numeric"
            value={fours}
            onChange={(e) => setFours(e.target.value)}
            aria-invalid={errors["fours"] ? true : undefined}
            aria-describedby={errors["fours"] ? "fours-error" : "fours-hint"}
          />
        </Field>
        {error ? <ErrorPanel error={error} /> : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Creating..." : "Start practice"}
        </button>
      </form>
    </>
  );
}

// --- saves -------------------------------------------------------------------------
export function SavesScreen() {
  const { identity, api } = useApp();
  const [extra, setExtra] = useState<GameView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const list = useAsync(
    async (signal) => {
      if (!identity) return null;
      const page = await api.listGames(undefined, signal);
      setExtra([]);
      setCursor(page.nextCursor);
      return page.items;
    },
    [api, identity?.userId],
  );
  const guest = isEngineAvailable() ? loadGuestGame() : null;

  const loadMore = async () => {
    if (!cursor) return;
    setMoreError(null);
    try {
      const page = await api.listGames(cursor);
      setExtra((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreError(e);
    }
  };

  const items = [...(list.data ?? []), ...extra];
  return (
    <>
      <PageHeading title="Saved games" subtitle="Resume anything in progress." />
      <section aria-label="Guest game on this browser" className="panel">
        <h2 className="panel-title">This browser</h2>
        {guest && guest.state.status === "active" ? (
          <div className="row between">
            <span>
              {guest.mode === "practice" ? `Practice ${guest.state.board.size}x${guest.state.board.size}` : "Classic"} - score {groupDecimal(guest.state.score)} -{" "}
              {guest.state.acceptedMoves} moves
            </span>
            <Link to="/play" className="btn btn-primary">
              Resume
            </Link>
          </div>
        ) : (
          <p className="muted">No guest game saved here.</p>
        )}
      </section>
      <section aria-label="Server games" className="panel">
        <h2 className="panel-title">Account games</h2>
        {!identity ? (
          <p className="muted">
            <Link to="/login">Sign in</Link> to see games saved on the local server.
          </p>
        ) : list.status === "loading" ? (
          <Spinner label="Loading saved games" />
        ) : list.status === "error" ? (
          <ErrorPanel error={list.error} onRetry={list.reload} />
        ) : items.length === 0 ? (
          <EmptyState title="Nothing saved yet">Start a game from the mode picker. It will show up here.</EmptyState>
        ) : (
          <ul className="list">
            {items.map((game) => {
              const max = maxExponentOf(game.state.board.cells);
              return (
                <li key={game.id} className="list-item">
                  <div>
                    <strong>{game.mode}</strong> <span className="tag">{game.state.status}</span>
                    <div className="muted">
                      Score {groupDecimal(game.state.score)}, best {max ? tileLabel(max, "numbers") : "-"}, updated {formatDate(game.updatedAt)}
                    </div>
                  </div>
                  <Link to={game.state.status === "active" ? `/play/${game.id}` : `/replays/${game.id}`} className="btn">
                    {game.state.status === "active" ? "Resume" : "Replay"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {cursor ? (
          <button type="button" className="btn" onClick={() => void loadMore()}>
            Load more
          </button>
        ) : null}
        {moreError ? <ErrorPanel error={moreError} onRetry={() => void loadMore()} /> : null}
      </section>
    </>
  );
}

// --- challenges --------------------------------------------------------------------
export function ChallengesScreen() {
  const { api, identity, isUser } = useApp();
  const list = useAsync(async (signal) => (isUser ? challengeItems(await api.challenges(signal)) : []), [api, identity?.userId]);
  return (
    <>
      <PageHeading title="Ranked challenges" subtitle="Fixed 4x4 rules, 500 accepted moves, no undo. One official attempt each." />
      {!isUser ? (
        <EmptyState title="Ranked play needs a local account">
          <Link to="/login">Sign in</Link> or <Link to="/register">create an account</Link>. Guests cannot enter ranked ladders.
        </EmptyState>
      ) : list.status === "loading" ? (
        <Spinner label="Loading challenges" />
      ) : list.status === "error" ? (
        <ErrorPanel error={list.error} onRetry={list.reload} />
      ) : list.data.length === 0 ? (
        <EmptyState title="No challenges are open">The local catalog is empty. Nothing is hidden or faked here.</EmptyState>
      ) : (
        <ul className="list">
          {list.data.map((challenge) => (
            <li key={challenge.id} className="list-item">
              <div>
                <strong>{challenge.title}</strong> <span className="tag">{challenge.status}</span>
                <div className="muted">
                  {challenge.moveCap} moves, {challenge.rulesetVersion}
                  {challenge.myAttempt ? `, your attempt: ${challenge.myAttempt.status}` : ""}
                </div>
              </div>
              <Link to={`/challenges/${challenge.id}`} className="btn">
                Details
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ChallengeDetailScreen(props: { id: string }) {
  const { api, identity, isUser } = useApp();
  const navigate = useNavigate();
  const list = useAsync(async (signal) => (isUser ? challengeItems(await api.challenges(signal)) : []), [api, identity?.userId]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const challenge: Challenge | undefined = list.data?.find((c) => c.id === props.id);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const game = await api.startAttempt(props.id);
      navigate(`/play/${game.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!isUser) {
    return (
      <EmptyState title="Sign in to enter a challenge">
        <Link to="/login">Sign in</Link> first. Guests cannot enter ranked ladders.
      </EmptyState>
    );
  }
  if (list.status === "loading") return <Spinner label="Loading challenge" />;
  if (list.status === "error") return <ErrorPanel error={list.error} onRetry={list.reload} />;
  if (!challenge) {
    return (
      <EmptyState title="Challenge not found">
        It may be closed or belong to another season. <Link to="/challenges">Back to challenges</Link>
      </EmptyState>
    );
  }
  const attempt = challenge.myAttempt;
  return (
    <>
      <PageHeading title={challenge.title} subtitle={`${challenge.rulesetVersion}, ${challenge.moveCap} accepted moves, ${challenge.status}`} />
      <div className="panel">
        <p>
          The seed is owned by the server and shared by every attempt. Abandoning an attempt forfeits it and the attempt is consumed. Undo and custom rules are
          not available.
        </p>
        {attempt ? (
          <p>
            Your attempt is <strong>{attempt.status}</strong>.
          </p>
        ) : null}
        <div className="row">
          {attempt?.status === "active" ? (
            <Link to={`/play/${attempt.gameId}`} className="btn btn-primary">
              Resume attempt
            </Link>
          ) : attempt ? (
            <Link to={`/replays/${attempt.gameId}`} className="btn">
              Replay my attempt
            </Link>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy || challenge.status !== "open"} onClick={() => void start()}>
              {busy ? "Starting..." : "Start official attempt"}
            </button>
          )}
          <Link to={`/leaderboards?kind=challenge&challenge=${encodeURIComponent(challenge.id)}`} className="btn">
            Standings
          </Link>
        </div>
        {error ? <ErrorPanel error={error} onRetry={() => void start()} /> : null}
      </div>
    </>
  );
}

// --- leaderboards ------------------------------------------------------------------
const KINDS: { kind: LeaderboardKind; label: string }[] = [
  { kind: "casual", label: "Casual best" },
  { kind: "challenge", label: "Challenge standings" },
  { kind: "duel-elo", label: "Duel Elo" },
  { kind: "bot", label: "Bot league" },
];

export function LeaderboardsScreen(props: { initialKind?: LeaderboardKind; initialChallenge?: string }) {
  const { api } = useApp();
  const [kind, setKind] = useState<LeaderboardKind>(props.initialKind ?? "casual");
  const [ruleset, setRuleset] = useState("");
  const [season, setSeason] = useState("");
  const [challenge, setChallenge] = useState(props.initialChallenge ?? "");
  const [account, setAccount] = useState("");
  const [extra, setExtra] = useState<LeaderboardEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<unknown>(null);

  const base = {
    kind,
    ruleset: ruleset.trim() || undefined,
    season: season.trim() || undefined,
    challenge: challenge.trim() || undefined,
    account: account.trim() || undefined,
    limit: 25,
  };
  const page = useAsync(
    async (signal) => {
      const result: Page<LeaderboardEntry> = await api.leaderboard(base, signal);
      setExtra([]);
      setCursor(result.nextCursor);
      return result.items;
    },
    [api, kind, ruleset, season, challenge, account],
  );

  const loadMore = async () => {
    if (!cursor) return;
    setMoreError(null);
    try {
      const result = await api.leaderboard({ ...base, cursor });
      setExtra((prev) => [...prev, ...result.items]);
      setCursor(result.nextCursor);
    } catch (e) {
      setMoreError(e);
    }
  };

  const rows = [...(page.data ?? []), ...extra];
  const eloView = kind === "duel-elo";
  return (
    <>
      <PageHeading title="Leaderboards" subtitle="Casual, challenge, human duel and bot results are never mixed." />
      <div className="tabs" role="tablist" aria-label="Leaderboard type">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="tab"
            id={`tab-${k.kind}`}
            aria-selected={kind === k.kind}
            aria-controls="board-panel"
            className={`tab${kind === k.kind ? " tab-active" : ""}`}
            onClick={() => setKind(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="panel" id="board-panel" role="tabpanel" aria-labelledby={`tab-${kind}`}>
        <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
          <Field id="f-ruleset" label="Ruleset">
            <input id="f-ruleset" value={ruleset} onChange={(e) => setRuleset(e.target.value)} placeholder="e.g. classic-v1" />
          </Field>
          <Field id="f-season" label="Season">
            <input id="f-season" value={season} onChange={(e) => setSeason(e.target.value)} />
          </Field>
          {kind === "challenge" ? (
            <Field id="f-challenge" label="Challenge">
              <input id="f-challenge" value={challenge} onChange={(e) => setChallenge(e.target.value)} />
            </Field>
          ) : null}
          <Field id="f-account" label="Account id">
            <input id="f-account" value={account} onChange={(e) => setAccount(e.target.value)} />
          </Field>
        </form>
        {page.status === "loading" ? (
          <Spinner label="Loading standings" />
        ) : page.status === "error" ? (
          <ErrorPanel error={page.error} onRetry={page.reload} />
        ) : rows.length === 0 ? (
          <EmptyState title="No results yet">Nothing has been recorded for this view. Results appear here after real games finish.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">{KINDS.find((k) => k.kind === kind)?.label}</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Player</th>
                  {eloView ? (
                    <>
                      <th scope="col">Rating</th>
                      <th scope="col">W / D / L</th>
                    </>
                  ) : (
                    <>
                      <th scope="col">Score</th>
                      <th scope="col">Best tile</th>
                    </>
                  )}
                  <th scope="col">Date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.rank}-${row.gameId ?? row.accountId ?? row.createdAt}`}>
                    <td>{row.rank}</td>
                    <td>{row.displayName}</td>
                    {eloView ? (
                      <>
                        <td>{row.rating ?? "-"}</td>
                        <td>
                          {row.won ?? 0} / {row.drawn ?? 0} / {row.lost ?? 0}
                        </td>
                      </>
                    ) : (
                      <>
                        <td title={row.score}>{row.score ? groupDecimal(row.score) : "-"}</td>
                        <td>{row.maxExponent ? tileLabel(row.maxExponent, "numbers") : "-"}</td>
                      </>
                    )}
                    <td>{formatDate(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor ? (
          <button type="button" className="btn" onClick={() => void loadMore()}>
            Load more
          </button>
        ) : null}
        {moreError ? <ErrorPanel error={moreError} onRetry={() => void loadMore()} /> : null}
      </div>
    </>
  );
}
