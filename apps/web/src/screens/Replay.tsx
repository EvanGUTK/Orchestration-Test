import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { Direction, DomainEvent, GameState, ReplaySummary, ReplayView } from "@2048/contracts";
import { REPLAY_SCHEMA_VERSION } from "@2048/contracts";
import { ApiRequestError } from "../api/client.ts";
import { BoardView } from "../components/Board.tsx";
import { ErrorPanel, Field, PageHeading, Spinner } from "../components/common.tsx";
import { ScoreCard } from "../components/GamePlay.tsx";
import { getEngine } from "../engine/port.ts";
import { formatDate, groupDecimal, maxExponentOf, tileLabel, tileSpoken } from "../format.ts";
import { advanceTiles, createIdSource, tilesFromBoard } from "../game/tiles.ts";
import type { TileView } from "../game/tiles.ts";
import { Link, useNavigate } from "../router.tsx";
import { useApp } from "../state/app.tsx";
import { useAsync } from "../state/useAsync.ts";

export const MAX_REPLAY_FILE_BYTES = 8 * 1024 * 1024;

/** Structural validation of an untrusted replay document. Throws ApiRequestError(IMPORT_INVALID / REPLAY_VERSION_UNSUPPORTED). */
export function parseReplayDocument(text: string): ReplayView {
  if (text.length > MAX_REPLAY_FILE_BYTES) throw new ApiRequestError("IMPORT_INVALID", "This replay file is too large.", 400, null);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiRequestError("IMPORT_INVALID", "This file is not valid JSON.", 400, null);
  }
  const doc = value as Partial<ReplayView> | null;
  if (typeof doc !== "object" || doc === null) throw new ApiRequestError("IMPORT_INVALID", "This file is not a replay.", 400, null);
  if (doc.schemaVersion !== REPLAY_SCHEMA_VERSION) {
    throw new ApiRequestError("REPLAY_VERSION_UNSUPPORTED", `Replay schema version ${String(doc.schemaVersion)} is not supported by this build.`, 400, null);
  }
  if (typeof doc.seed !== "string" || typeof doc.ruleset !== "object" || doc.ruleset === null || !Array.isArray(doc.moves)) {
    throw new ApiRequestError("IMPORT_INVALID", "The replay is missing its seed, ruleset or moves.", 400, null);
  }
  const directions = ["up", "right", "down", "left"];
  for (const move of doc.moves) {
    if (!move || !directions.includes((move as { direction?: string }).direction ?? "")) {
      throw new ApiRequestError("IMPORT_INVALID", "The replay contains an invalid move.", 400, null);
    }
  }
  return doc as ReplayView;
}

export function describeEvents(events: readonly DomainEvent[]): string[] {
  const lines: string[] = [];
  const moved = events.filter((e) => e.type === "move").length;
  if (moved > 0) lines.push(`${moved} tile${moved === 1 ? "" : "s"} slid.`);
  for (const e of events) {
    if (e.type === "merge") lines.push(`Two ${tileSpoken(String(BigInt(e.exponent) - 1n))} tiles merged into ${tileSpoken(e.exponent)} (+${groupDecimal(e.value)} points).`);
    else if (e.type === "spawn") lines.push(`A new ${tileSpoken(e.exponent)} appeared.`);
    else if (e.type === "milestone") lines.push(`Milestone: first ${tileSpoken(e.exponent)} tile.`);
    else if (e.type === "game-over") lines.push("The board is dead: game over.");
    else if (e.type === "move-cap") lines.push("The move cap was reached.");
  }
  if (lines.length === 0) lines.push("Nothing happened on this move.");
  return lines;
}

type Position = { count: number; state: GameState; events: DomainEvent[]; tiles: TileView[]; checksum: string | null };

/** Seekable replay engine: snapshots bound the recompute window, nothing is materialised for the whole history. */
export class ReplaySeeker {
  private readonly replay: ReplayView;
  private readonly initial: GameState;
  private readonly snapshotAt: { count: number; state: GameState }[];
  private cache: { count: number; state: GameState } | null = null;
  private readonly ids = createIdSource();
  private lastTiles: { count: number; tiles: TileView[] } | null = null;

  constructor(replay: ReplayView) {
    this.replay = replay;
    this.initial = getEngine().newGame(replay.ruleset, replay.seed);
    const countBySequence = new Map<number, number>();
    replay.moves.forEach((m, i) => countBySequence.set(m.sequence, i + 1));
    this.snapshotAt = [{ count: 0, state: this.initial }];
    for (const snap of replay.snapshots ?? []) {
      const count = countBySequence.get(snap.sequence);
      if (count !== undefined) this.snapshotAt.push({ count, state: snap.state });
    }
    this.snapshotAt.sort((a, b) => a.count - b.count);
  }

  get length(): number {
    return this.replay.moves.length;
  }

  private stateAt(count: number): GameState {
    const engine = getEngine();
    let base = this.snapshotAt[0] ?? { count: 0, state: this.initial };
    for (const snap of this.snapshotAt) if (snap.count <= count && snap.count >= base.count) base = snap;
    if (this.cache && this.cache.count <= count && this.cache.count >= base.count) base = this.cache;
    let state = base.state;
    for (let i = base.count; i < count; i++) {
      const move = this.replay.moves[i];
      if (!move) break;
      state = engine.applyMove(state, move.direction as Direction, this.replay.ruleset).state;
    }
    this.cache = { count, state };
    return state;
  }

  at(count: number): Position {
    const clamped = Math.max(0, Math.min(this.length, Math.trunc(count)));
    const engine = getEngine();
    if (clamped === 0) {
      this.lastTiles = { count: 0, tiles: tilesFromBoard(this.initial.board, this.ids) };
      return { count: 0, state: this.initial, events: [], tiles: this.lastTiles.tiles, checksum: null };
    }
    const before = this.stateAt(clamped - 1);
    const move = this.replay.moves[clamped - 1] as ReplayView["moves"][number];
    const result = engine.applyMove(before, move.direction as Direction, this.replay.ruleset);
    this.cache = { count: clamped, state: result.state };
    const tiles =
      this.lastTiles && this.lastTiles.count === clamped - 1 && result.changed
        ? advanceTiles(this.lastTiles.tiles, result.events, result.state.board, this.ids)
        : tilesFromBoard(result.state.board, this.ids);
    this.lastTiles = { count: clamped, tiles };
    return { count: clamped, state: result.state, events: result.events, tiles, checksum: engine.stateChecksum(result.state) };
  }

  expectedChecksum(count: number): string | null {
    return count === 0 ? null : (this.replay.moves[count - 1]?.checksum ?? null);
  }
}

const SPEEDS = [0.5, 1, 2, 4];

export function ReplayPlayer(props: { replay: ReplayView; title?: string }) {
  const { prefs } = useApp();
  const seeker = useMemo(() => new ReplaySeeker(props.replay), [props.replay]);
  const [count, setCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const position = useMemo(() => seeker.at(count), [seeker, count]);
  const expected = seeker.expectedChecksum(count);
  const verified = position.checksum === null ? null : expected === null ? null : position.checksum === expected;
  const countRef = useRef(count);
  countRef.current = count;

  useEffect(() => {
    setCount(0);
    setPlaying(false);
  }, [seeker]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (countRef.current >= seeker.length) {
        setPlaying(false);
        return;
      }
      setCount((c) => Math.min(seeker.length, c + 1));
    }, 600 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, seeker]);

  const go = useCallback((n: number) => setCount(Math.max(0, Math.min(seeker.length, n))), [seeker]);
  const max = maxExponentOf(position.state.board.cells);
  const finalMatch = props.replay.finalScore === undefined ? null : count === seeker.length ? position.state.score === props.replay.finalScore : null;

  return (
    <section aria-label="Replay player">
      <div className="score-row">
        <ScoreCard label="Score" value={groupDecimal(position.state.score)} title={position.state.score} />
        <ScoreCard label="Best tile" value={max ? tileLabel(max, prefs.tileStyle) : "-"} />
        <ScoreCard label="Move" value={`${count} / ${seeker.length}`} />
      </div>
      <div className="board-wrap">
        <BoardView board={position.state.board} tiles={position.tiles} tileStyle={prefs.tileStyle} keyBindings={prefs.keyBindings} label={props.title ?? "Replay board"} interactive={false} />
      </div>
      <div className="row replay-controls" role="group" aria-label="Replay controls">
        <button type="button" className="btn" onClick={() => go(0)} disabled={count === 0}>
          Start
        </button>
        <button type="button" className="btn" onClick={() => go(count - 1)} disabled={count === 0}>
          Step back
        </button>
        <button type="button" className="btn btn-primary" onClick={() => (count >= seeker.length ? (go(0), setPlaying(true)) : setPlaying(!playing))}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="btn" onClick={() => go(count + 1)} disabled={count >= seeker.length}>
          Step
        </button>
        <button type="button" className="btn" onClick={() => go(seeker.length)} disabled={count >= seeker.length}>
          End
        </button>
        <label className="inline-field">
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <label htmlFor="replay-seek">Seek to move</label>
        <input id="replay-seek" type="range" min={0} max={seeker.length} value={count} onChange={(e) => go(Number(e.target.value))} aria-valuetext={`Move ${count} of ${seeker.length}`} />
      </div>
      <div className="panel" aria-live="polite">
        <h2 className="panel-title">
          {count === 0 ? "Initial position" : `Move ${count}: ${(props.replay.moves[count - 1]?.direction ?? "").toString()}`}
        </h2>
        <ul>
          {describeEvents(position.events).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        <p className="muted">
          Checksum:{" "}
          {verified === null ? "n/a" : verified ? "matches the recorded value" : "does NOT match the recorded value (the replay may contain undo branches or a different engine version)"}
          {finalMatch === null ? "" : finalMatch ? ". Final score matches." : ". Final score differs from the recorded one."}
        </p>
      </div>
    </section>
  );
}

// --- screens -----------------------------------------------------------------------
function ReplayList() {
  const { api } = useApp();
  const [extra, setExtra] = useState<ReplaySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const list = useAsync(
    async (signal) => {
      const page = await api.replays(undefined, signal);
      setExtra([]);
      setCursor(page.nextCursor);
      return page.items;
    },
    [api],
  );
  const more = async () => {
    if (!cursor) return;
    setMoreError(null);
    try {
      const page = await api.replays(cursor);
      setExtra((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreError(e);
    }
  };
  const items = [...(list.data ?? []), ...extra];
  return (
    <section className="panel" aria-label="My finished games">
      <h2 className="panel-title">My finished games</h2>
      {list.status === "loading" ? (
        <Spinner label="Loading replays" />
      ) : list.status === "error" ? (
        <ErrorPanel error={list.error} onRetry={list.reload} />
      ) : items.length === 0 ? (
        <p className="muted">No finished games yet. Finish or forfeit a game and it will be listed here.</p>
      ) : (
        <ul className="list">
          {items.map((item) => (
            <li key={item.gameId} className="list-item">
              <div>
                <strong>{item.mode}</strong> <span className="tag">{item.rulesetVersion}</span>
                <div className="muted">
                  Score {groupDecimal(item.finalScore)}, best {tileLabel(item.maxExponent, "numbers")}, {item.acceptedMoves} moves, {formatDate(item.createdAt)}
                </div>
              </div>
              <Link to={`/replays/${item.gameId}`} className="btn">
                Replay
              </Link>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <button type="button" className="btn" onClick={() => void more()}>
          Load more
        </button>
      ) : null}
      {moreError ? <ErrorPanel error={moreError} onRetry={() => void more()} /> : null}
    </section>
  );
}

export function ReplayHomeScreen() {
  const { api, identity } = useApp();
  const navigate = useNavigate();
  const [id, setId] = useState("");
  const [local, setLocal] = useState<ReplayView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);

  const open = (event: FormEvent) => {
    event.preventDefault();
    if (id.trim()) navigate(`/replays/${encodeURIComponent(id.trim())}`);
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setError(null);
    setMessage(null);
    setLocal(null);
    if (!file) return;
    if (file.size > MAX_REPLAY_FILE_BYTES) {
      setError(new ApiRequestError("IMPORT_INVALID", "This replay file is too large.", 400, null));
      return;
    }
    try {
      setLocal(parseReplayDocument(await file.text()));
    } catch (e) {
      setError(e);
    }
  };

  const importToServer = async () => {
    if (!local) return;
    setError(null);
    try {
      await api.importReplay(local);
      setMessage("Imported. Imported replays are never ranked.");
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <PageHeading title="Replays" subtitle="Step through a finished game and see why each merge happened." />
      <form className="panel form" onSubmit={open} aria-label="Open replay by id">
        <h2 className="panel-title">Open a game replay</h2>
        <Field id="r-id" label="Game id" hint="Finished games link here from the saved games list.">
          <input id="r-id" value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} aria-describedby="r-id-hint" />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={!id.trim() || !identity}>
          Open
        </button>
        {!identity ? <p className="muted">Sign in to open server replays. You can still load a file below.</p> : null}
      </form>
      {identity ? <ReplayList /> : null}
      <section className="panel" aria-label="Replay file">
        <h2 className="panel-title">Load a replay file</h2>
        <Field id="r-file" label="Replay JSON file" hint="Validated here before anything is shown. Up to 8 MB.">
          <input id="r-file" type="file" accept="application/json,.json" onChange={(e) => void onFile(e)} aria-describedby="r-file-hint" />
        </Field>
        {error ? <ErrorPanel error={error} /> : null}
        {message ? <p role="status">{message}</p> : null}
        {local ? (
          <>
            <div className="row">
              {identity ? (
                <button type="button" className="btn" onClick={() => void importToServer()}>
                  Also import to my account
                </button>
              ) : null}
            </div>
            <ReplayPlayer replay={local} title="Replay from file" />
          </>
        ) : null}
      </section>
    </>
  );
}

export function ReplayScreen(props: { id: string }) {
  const { api, identity } = useApp();
  const replay = useAsync((signal) => api.getReplay(props.id, signal), [api, props.id]);
  if (!identity) return <ErrorPanel error={new ApiRequestError("UNAUTHENTICATED", "Sign in to open server replays.", 401, null)} extra={<Link to="/login" className="btn">Sign in</Link>} />;
  if (replay.status === "loading") return <Spinner label="Loading replay" />;
  if (replay.status === "error") return <ErrorPanel error={replay.error} onRetry={replay.reload} />;
  return (
    <>
      <PageHeading title="Replay" subtitle={`${replay.data.rulesetVersion}, ${replay.data.moves.length} accepted moves, engine ${replay.data.engineVersion}`} />
      <ReplayPlayer replay={replay.data} />
    </>
  );
}
