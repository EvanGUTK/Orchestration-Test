import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { BotConfig, BotRunView, BotStrategy, GameView, MatchKind, MatchView, SeatView } from "@2048/contracts";
import { BOT_VERSION, DUEL_RULES } from "@2048/contracts";
import { useRealtime } from "../api/realtime.ts";
import { BoardView } from "../components/Board.tsx";
import { EmptyState, ErrorPanel, Field, PageHeading, Spinner } from "../components/common.tsx";
import { GamePlay, ScoreCard } from "../components/GamePlay.tsx";
import { newSeed } from "../api/ids.ts";
import { groupDecimal, tileLabel } from "../format.ts";
import { GameController } from "../game/controller.ts";
import { useGameController } from "../game/hooks.ts";
import { createIdSource, tilesFromBoard } from "../game/tiles.ts";
import { RemoteTransport } from "../game/transports.ts";
import { Link, useNavigate } from "../router.tsx";
import { useApp } from "../state/app.tsx";
import { useAsync } from "../state/useAsync.ts";

const STRATEGIES: { value: BotStrategy; label: string }[] = [
  { value: "random", label: "Random legal move" },
  { value: "greedy", label: "Greedy merge score" },
  { value: "heuristic", label: "Heuristic search" },
  { value: "expectimax", label: "Bounded expectimax" },
];

export function BotConfigFields(props: { prefix: string; config: BotConfig; onChange(config: BotConfig): void }) {
  const { prefix, config, onChange } = props;
  return (
    <>
      <Field id={`${prefix}-strategy`} label="Strategy">
        <select id={`${prefix}-strategy`} value={config.strategy} onChange={(e) => onChange({ ...config, strategy: e.target.value as BotStrategy })}>
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${prefix}-seed`} label="Bot seed" hint="Separate from the game seed. Tie-breaks only.">
        <input id={`${prefix}-seed`} value={config.seed} onChange={(e) => onChange({ ...config, seed: e.target.value })} spellCheck={false} aria-describedby={`${prefix}-seed-hint`} />
      </Field>
      <Field id={`${prefix}-nodes`} label="Node budget per move">
        <input id={`${prefix}-nodes`} inputMode="numeric" value={String(config.nodeBudget)} onChange={(e) => onChange({ ...config, nodeBudget: Math.max(1, Math.min(1_000_000, Math.trunc(Number(e.target.value)) || 1)) })} />
      </Field>
      <Field id={`${prefix}-time`} label="Time budget per move (ms)">
        <input id={`${prefix}-time`} inputMode="numeric" value={String(config.timeBudgetMs)} onChange={(e) => onChange({ ...config, timeBudgetMs: Math.max(1, Math.min(10_000, Math.trunc(Number(e.target.value)) || 1)) })} />
      </Field>
    </>
  );
}

export function defaultBot(): BotConfig {
  return { strategy: "expectimax", seed: newSeed().slice(0, 8), nodeBudget: 2000, timeBudgetMs: 50 };
}

// --- duel lobby --------------------------------------------------------------------
export function DuelLobbyScreen() {
  const { identity, api } = useApp();
  const navigate = useNavigate();
  const [kind, setKind] = useState<MatchKind>("human-vs-human");
  const [bot, setBot] = useState<BotConfig>(defaultBot);
  const [opponentBot, setOpponentBot] = useState<BotConfig>(() => ({ ...defaultBot(), strategy: "greedy" }));
  const [joinId, setJoinId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (!identity) {
    return (
      <>
        <PageHeading title="Duel lobby" />
        <EmptyState title="Duels need a local account">
          <Link to="/login">Sign in</Link> or <Link to="/register">create an account</Link>. Use a separate browser profile for a second human.
        </EmptyState>
      </>
    );
  }

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const match = await api.createMatch({
        kind,
        ...(kind !== "human-vs-human" ? { bot } : {}),
        ...(kind === "bot-vs-bot" ? { opponentBot } : {}),
      });
      navigate(`/duel/${match.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (!joinId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const match = await api.joinMatch(joinId.trim());
      navigate(`/duel/${match.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeading title="Duel lobby" subtitle="Same seed, 500 accepted moves per seat. Decided by score, then best tile. No clock." />
      <div className="card-grid">
        <form className="panel form" onSubmit={(e) => void create(e)} aria-label="Create match">
          <h2 className="panel-title">Create a match</h2>
          <Field id="m-kind" label="Opponent">
            <select id="m-kind" value={kind} onChange={(e) => setKind(e.target.value as MatchKind)}>
              <option value="human-vs-human">Another local account (rated)</option>
              <option value="human-vs-bot">A bot (separate result board)</option>
              <option value="bot-vs-bot">Bot vs bot (watch)</option>
            </select>
          </Field>
          {kind !== "human-vs-human" ? (
            <fieldset className="fieldset">
              <legend>{kind === "bot-vs-bot" ? "Bot A" : "Bot opponent"}</legend>
              <BotConfigFields prefix="duel-bot" config={bot} onChange={setBot} />
            </fieldset>
          ) : null}
          {kind === "bot-vs-bot" ? (
            <fieldset className="fieldset">
              <legend>Bot B</legend>
              <BotConfigFields prefix="duel-bot2" config={opponentBot} onChange={setOpponentBot} />
            </fieldset>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Creating..." : "Create match"}
          </button>
        </form>
        <form className="panel form" onSubmit={(e) => void join(e)} aria-label="Join match">
          <h2 className="panel-title">Join a match</h2>
          <p className="muted">Ask the host for the match id. You must be signed in with a different account.</p>
          <Field id="j-id" label="Match id">
            <input id="j-id" value={joinId} onChange={(e) => setJoinId(e.target.value)} spellCheck={false} autoCapitalize="none" />
          </Field>
          <button type="submit" className="btn" disabled={busy || !joinId.trim()}>
            Join
          </button>
        </form>
      </div>
      {error ? <ErrorPanel error={error} /> : null}
    </>
  );
}

// --- split-board duel --------------------------------------------------------------
function ReadOnlyBoard(props: { game: GameView; label: string }) {
  const { prefs } = useApp();
  const tiles = useMemo(() => tilesFromBoard(props.game.state.board, createIdSource()), [props.game.state]);
  return (
    <BoardView board={props.game.state.board} tiles={tiles} tileStyle={prefs.tileStyle} keyBindings={prefs.keyBindings} label={props.label} interactive={false} />
  );
}

function SeatSummary(props: { seat: SeatView | null; mine: boolean }) {
  const { seat, mine } = props;
  if (!seat) {
    return (
      <div className="panel">
        <h3 className="panel-title">Waiting for an opponent</h3>
        <p className="muted">Share the match id so another account can join.</p>
      </div>
    );
  }
  return (
    <div className="panel" aria-label={`Seat ${seat.seat + 1}`}>
      <h3 className="panel-title">
        {seat.displayName} {mine ? "(you)" : ""} <span className="tag">{seat.kind}</span>
      </h3>
      <div className="score-row">
        <ScoreCard label="Score" value={seat.score ? groupDecimal(seat.score) : "-"} title={seat.score ?? ""} />
        <ScoreCard label="Best tile" value={seat.maxExponent ? tileLabel(seat.maxExponent, "numbers") : "-"} />
        <ScoreCard label="Moves" value={`${seat.acceptedMoves ?? 0} / ${DUEL_RULES.moveCap ?? 500}`} />
      </div>
      <p className="muted">{seat.terminalReason ? `Finished: ${seat.terminalReason}` : "Playing"}</p>
    </div>
  );
}

function MySeat(props: { view: GameView; onChanged(): void }) {
  const { api } = useApp();
  const { view } = props;
  const controller = useGameController(view.id, () => new GameController(view.state, new RemoteTransport(api, view.id, false)));
  return <GamePlay controller={controller} label="Your board" moveCap={DUEL_RULES.moveCap} showPad onFinished={props.onChanged} statusNote="Official rules: no undo." />;
}

export function DuelScreen(props: { id: string }) {
  const { api, identity } = useApp();
  const match = useAsync((signal) => api.getMatch(props.id, signal), [api, props.id]);
  const [live, setLive] = useState<MatchView | null>(null);
  const [tick, setTick] = useState(0);
  const current = live ?? match.data;

  const status = useRealtime(
    [props.id],
    (envelope) => {
      if (envelope.type === "match.finished" || envelope.type === "match.seat-ended" || envelope.type === "game.updated" || envelope.type === "rating.updated") {
        void api.getMatch(props.id).then(
          (fresh) => {
            setLive(fresh);
            setTick((t) => t + 1);
          },
          () => undefined,
        );
      }
    },
    () => {
      void api.getMatch(props.id).then(setLive, () => undefined);
    },
    Boolean(identity),
  );

  if (!identity) return <EmptyState title="Sign in to view this match"><Link to="/login">Sign in</Link></EmptyState>;
  if (match.status === "loading") return <Spinner label="Loading match" />;
  if (match.status === "error") return <ErrorPanel error={match.error} onRetry={match.reload} />;
  if (!current) return null;

  const [seat0, seat1] = current.seats;
  return (
    <>
      <PageHeading
        title={`Duel: ${current.kind}`}
        subtitle={`Match ${current.id} - ${current.status}${current.outcome ? ` - outcome: ${current.outcome}` : ""}`}
      />
      {status === "reconnecting" ? (
        <p className="notice" role="status">
          Live connection lost. Reconnecting and catching up; your moves are kept by the server.
        </p>
      ) : null}
      {current.status === "lobby" ? (
        <EmptyState title="Waiting in the lobby">
          Give this id to the other player: <code>{current.id}</code>. The match starts when they join. A duel with an absent player stays pending until someone forfeits.
        </EmptyState>
      ) : null}
      <div className="split" aria-label="Split-board duel">
        {[seat0, seat1].map((seat, i) => (
          <SeatColumn key={i} seat={seat} tick={tick} />
        ))}
      </div>
      {current.status === "finished" ? (
        <section className="panel" aria-label="Result">
          <h2 className="panel-title">Result</h2>
          <p>{current.outcome === "draw" ? "Draw." : current.outcome === "seat0" ? `${seat0.displayName} wins.` : `${seat1?.displayName ?? "Seat 2"} wins.`}</p>
          {current.ratingEvents.length > 0 ? (
            <ul className="list">
              {current.ratingEvents.map((r) => (
                <li key={r.idempotencyKey} className="list-item">
                  Elo {r.before} to {r.after} ({r.delta >= 0 ? "+" : ""}
                  {r.delta})
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No Elo change: only two human accounts are rated.</p>
          )}
          {seat0.gameId ? <Link to={`/replays/${seat0.gameId}`} className="btn">Replay seat 1</Link> : null}
        </section>
      ) : null}
    </>
  );
}

function SeatColumn(props: { seat: SeatView | null; tick: number }) {
  const { api } = useApp();
  const { seat, tick } = props;
  const game = useAsync(
    async (signal) => {
      if (!seat?.gameId) return null;
      try {
        return await api.getGame(seat.gameId, signal);
      } catch {
        return null; // the opponent's game is not ours to read; the summary card is shown instead
      }
    },
    [api, seat?.gameId, tick],
  );
  const mine = game.status === "ready" && game.data?.seat === seat?.seat && game.data?.mode === "duel";
  return (
    <div className="split-col">
      <SeatSummary seat={seat} mine={Boolean(mine)} />
      {game.status === "ready" && game.data ? (
        mine && game.data.state.status === "active" ? (
          <MySeat view={game.data} onChanged={() => undefined} />
        ) : (
          <ReadOnlyBoard game={game.data} label={`${seat?.displayName ?? "Seat"} board`} />
        )
      ) : game.status === "loading" ? (
        <Spinner label="Loading board" />
      ) : null}
    </div>
  );
}

// --- bot laboratory ----------------------------------------------------------------
export function BotLabScreen() {
  const { identity, api, prefs } = useApp();
  const [config, setConfig] = useState<BotConfig>(defaultBot);
  const [boardSize, setBoardSize] = useState("4");
  const [gameSeed, setGameSeed] = useState("");
  const [run, setRun] = useState<BotRunView | null>(null);
  const [game, setGame] = useState<GameView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const refreshGame = async (id: string) => {
    try {
      setGame(await api.getGame(id));
    } catch {
      /* the run view still shows progress; the board appears once the game is readable */
    }
  };

  useRealtime(
    run ? [run.id] : [],
    (envelope) => {
      if (envelope.type === "bot.progress" || envelope.type === "bot.finished") {
        const payload = envelope.payload as { run?: BotRunView } | BotRunView;
        const next = "run" in payload && payload.run ? payload.run : (payload as BotRunView);
        if (next && typeof next === "object" && "status" in next) {
          setRun(next);
          if (next.gameId) void refreshGame(next.gameId);
        }
      }
    },
    () => {
      if (run?.gameId) void refreshGame(run.gameId);
    },
    Boolean(run),
  );

  useEffect(() => {
    if (run?.gameId && !game) void refreshGame(run.gameId);
  }, [run?.gameId]);

  if (!identity) {
    return (
      <>
        <PageHeading title="Bot laboratory" />
        <EmptyState title="Bot runs need a local account">
          Bots run on the local server. <Link to="/login">Sign in</Link> to start one.
        </EmptyState>
      </>
    );
  }

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setGame(null);
    try {
      const size = Number(boardSize);
      const view = await api.startBotRun({
        config,
        mode: "exhibition",
        ...(Number.isInteger(size) ? { boardSize: size } : {}),
        ...(gameSeed.trim() ? { gameSeed: gameSeed.trim() } : {}),
      });
      setRun(view);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    try {
      setRun(await api.cancelBotRun(run.id));
    } catch (e) {
      setError(e);
    }
  };

  const running = run?.status === "running" || run?.status === "paused";
  return (
    <>
      <PageHeading title="Bot laboratory" subtitle={`Bots see the board and public rules only. Version ${BOT_VERSION}.`} />
      <div className="card-grid">
        <form className="panel form" onSubmit={(e) => void start(e)} aria-label="Bot run settings">
          <h2 className="panel-title">New exhibition</h2>
          <BotConfigFields prefix="lab" config={config} onChange={setConfig} />
          <Field id="lab-size" label="Board size" hint="3 to 8; the standard exhibition is 4.">
            <input id="lab-size" inputMode="numeric" value={boardSize} onChange={(e) => setBoardSize(e.target.value)} aria-describedby="lab-size-hint" />
          </Field>
          <Field id="lab-gameseed" label="Game seed (optional)">
            <input id="lab-gameseed" value={gameSeed} onChange={(e) => setGameSeed(e.target.value)} spellCheck={false} />
          </Field>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || running}>
              {busy ? "Starting..." : "Start run"}
            </button>
            <button type="button" className="btn" disabled={!running} onClick={() => void cancel()}>
              Stop
            </button>
          </div>
          <p className="muted">Playback speed preference: {prefs.botSpeed}. Pause and single-step controls appear here when the server exposes them.</p>
        </form>
        <section className="panel" aria-label="Run progress" aria-live="polite">
          <h2 className="panel-title">Run</h2>
          {error ? <ErrorPanel error={error} /> : null}
          {run ? (
            <>
              <p>
                <span className="tag">{run.status}</span> {run.config.strategy} - {run.moves} moves - {run.botVersion}
              </p>
              {run.lastExplanation ? <p>Last choice: {run.lastExplanation}</p> : null}
            </>
          ) : (
            <p className="muted">Start a run to watch it here.</p>
          )}
          {game ? <ReadOnlyBoard game={game} label="Bot board" /> : null}
          {game ? <p className="muted">Score {groupDecimal(game.state.score)}</p> : null}
        </section>
      </div>
    </>
  );
}
