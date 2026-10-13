import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { LIMITS } from "@g2048/contracts";
import type { Direction, ReplayFile } from "@g2048/contracts";
import { describeApiError, isApiError } from "../api/client.js";
import { useGameSnapshot, useServices, useSettings } from "../app/services.js";
import { Board } from "../components/Board.js";
import { ScoreDisplay, Stat } from "../components/ScoreDisplay.js";
import { TileText } from "../components/Tile.js";
import { VirtualList } from "../components/VirtualList.js";
import type { EnginePort } from "../game/engine-port.js";
import { buildReplayFile, explainEvents, ReplayCursor, replayFileName } from "../replay/replay.js";
import type { AnalyzedReplay, ReplayProblem } from "../replay/replay.js";
import { highestExponent } from "./PlayScreen.js";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;
const BASE_INTERVAL_MS = 500;
const ARROW: Record<Direction, string> = { up: "↑", right: "→", down: "↓", left: "←" };

export function downloadJson(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke after the click has been handled so the download isn't cancelled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ReplayPlayer({
  engine,
  replay,
  onClose,
}: {
  engine: EnginePort;
  replay: AnalyzedReplay;
  onClose: () => void;
}) {
  const { announcer } = useServices();
  const settings = useSettings();
  const cursor = useMemo(() => new ReplayCursor(engine, replay), [engine, replay]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const id = useId();
  const total = cursor.length;
  const frame = cursor.frame(index);
  const explanation = explainEvents(frame.events, frame.state.board.size);
  const top = highestExponent(frame.state);

  // Playback stops by itself at the end; pressing Play there restarts from the beginning.
  const running = playing && index < total;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setIndex((i) => Math.min(total, i + 1)), BASE_INTERVAL_MS / speed);
    return () => clearInterval(timer);
  }, [running, speed, total]);

  const go = (next: number, announce = true) => {
    const clamped = Math.max(0, Math.min(total, next));
    setIndex(clamped);
    if (announce) {
      const f = cursor.frame(clamped);
      announcer.announce(
        `Move ${clamped} of ${total}. ${explainEvents(f.events, f.state.board.size).join(" ")}`,
      );
    }
  };

  return (
    <section className="panel replay" aria-labelledby={`${id}-title`}>
      <div className="replay__head">
        <h2 className="panel__title" id={`${id}-title`}>
          Replay · {replay.rules.version} · {replay.rules.size}×{replay.rules.size}
        </h2>
        <p className="badge badge--ready">Verified by the engine</p>
        <p className="hint hint--small">
          {replay.file.meta.source === "import" ? "Imported file" : "Local game"} · seed{" "}
          <code className="seed">{replay.file.seed}</code> · replays are never ranked.
        </p>
      </div>

      <div className="stats">
        <ScoreDisplay label="Score" value={frame.state.score} />
        <Stat label="Move" value={`${index} / ${total}`} />
        <Stat label="Top" value={top ? <TileText exponent={top} style={settings.tileDisplay} /> : "—"} />
      </div>

      <Board
        board={frame.state.board}
        tileStyle={settings.tileDisplay}
        bindings={settings.keyBindings}
        lastMove={
          index > 0
            ? { seq: index, direction: replay.moves[index - 1] as Direction, events: frame.events }
            : null
        }
        label={`Replay board, position ${index} of ${total}`}
      />

      <div className="replay__controls" role="group" aria-label="Playback">
        <button
          type="button"
          className="button button--small"
          onClick={() => go(0)}
          disabled={index === 0}
          aria-label="Go to start"
        >
          ⏮
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => go(index - 1)}
          disabled={index === 0}
          aria-label="Step back"
        >
          ◀
        </button>
        <button
          type="button"
          className="button button--primary button--small"
          onClick={() => {
            if (index >= total) {
              setIndex(0);
              setPlaying(true);
            } else {
              setPlaying(!running);
            }
          }}
          aria-label={running ? "Pause" : "Play"}
        >
          {running ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => go(index + 1)}
          disabled={index >= total}
          aria-label="Step forward"
        >
          ▶
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => go(total)}
          disabled={index >= total}
          aria-label="Go to end"
        >
          ⏭
        </button>
        <label className="replay__speed">
          <span>Speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field">
        <label htmlFor={`${id}-seek`}>Position</label>
        <input
          id={`${id}-seek`}
          className="replay__seek"
          type="range"
          min={0}
          max={total}
          step={1}
          value={index}
          onChange={(e) => go(Number.parseInt(e.target.value, 10), false)}
          aria-valuetext={`Move ${index} of ${total}`}
        />
      </div>

      <div className="replay__explain" aria-labelledby={`${id}-explain`}>
        <h3 id={`${id}-explain`}>
          {index === 0
            ? "Starting position"
            : `Move ${index}: ${replay.moves[index - 1]} ${ARROW[replay.moves[index - 1] as Direction]}`}
          {index > 0 && frame.scoreDelta !== "0" ? ` (+${frame.scoreDelta})` : ""}
        </h3>
        {index === 0 ? (
          <p>Two starting tiles from the seed. Press Play or step forward.</p>
        ) : (
          <ul>
            {explanation.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      <VirtualList
        count={total}
        rowHeight={44}
        height={Math.min(264, Math.max(44, total * 44))}
        label={`Moves (${total})`}
        activeIndex={index - 1}
        renderRow={(i) => (
          <button
            type="button"
            className="vlist__btn"
            aria-current={i === index - 1 ? "step" : undefined}
            onClick={() => go(i + 1)}
          >
            <span className="vlist__num">{i + 1}</span>
            <span>
              {ARROW[replay.moves[i] as Direction]} {replay.moves[i]}
            </span>
          </button>
        )}
      />

      <div className="action-row">
        <button
          type="button"
          className="button"
          onClick={() => downloadJson(replayFileName(replay.file), replay.file)}
        >
          Export replay file
        </button>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close replay
        </button>
      </div>
    </section>
  );
}

const PROBLEM_HELP: Record<ReplayProblem["kind"], string> = {
  "too-large": "Choose a smaller file, or export the replay again from 2048 Infinite.",
  "not-json": "Pick a .json replay exported from 2048 Infinite.",
  "not-replay": "Pick a .json replay exported from 2048 Infinite.",
  "unsupported-version": "Open it with the version of 2048 Infinite that created it.",
  "unknown-ruleset": "This app only replays classic, ranked, duel, bot and practice rulesets.",
  "too-long": "Replays are limited so verification stays fast on this computer.",
  corrupt: "The file was changed after export or is damaged. It can't be played or trusted.",
};

export function ReplaysScreen() {
  const { api, engine, replayAnalyzer, localGame } = useServices();
  const local = useGameSnapshot(localGame);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking"; name: string }
    | { kind: "error"; problem: ReplayProblem; name: string }
    | { kind: "ready"; replay: AnalyzedReplay }
  >({ kind: "idle" });
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [serverId, setServerId] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  if (!engine || !replayAnalyzer) {
    return (
      <section className="panel">
        <p>Replays need the game engine, which isn't available in this build.</p>
      </section>
    );
  }

  const analyze = async (text: string, byteLength: number, name: string, imported: boolean) => {
    setState({ kind: "checking", name });
    const result = await replayAnalyzer.analyze(text, byteLength);
    if (!result.ok) {
      setState({ kind: "error", problem: result.problem, name });
      return;
    }
    // Imported files are always labelled as imports, whatever their meta claims (not part of the checksum).
    const replay = imported
      ? {
          ...result.replay,
          file: { ...result.replay.file, meta: { ...result.replay.file.meta, source: "import" as const } },
        }
      : result.replay;
    setState({ kind: "ready", replay });
  };

  const loadServer = async () => {
    const replayId = serverId.trim();
    if (!replayId) return;
    setServerError(null);
    setState({ kind: "checking", name: `server replay ${replayId}` });
    let file: unknown;
    try {
      file = await api.request<unknown>("GET", `/replays/${encodeURIComponent(replayId)}`);
    } catch (error) {
      setState({ kind: "idle" });
      setServerError(
        isApiError(error) && error.status === 404
          ? `No replay “${replayId}” is available from this server (it doesn't exist, isn't yours, or this server doesn't serve replays yet).`
          : `Couldn't load the replay. ${describeApiError(error)}`,
      );
      return;
    }
    const text = JSON.stringify(file);
    await analyze(text, new Blob([text]).size, `server replay ${replayId}`, false);
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > LIMITS.replayImportBytes) {
      // Rejected before reading, so a huge file never loads into memory.
      setState({
        kind: "error",
        name: file.name,
        problem: {
          kind: "too-large",
          atMove: null,
          message: `This file is ${(file.size / 1048576).toFixed(1)} MB; replay files are limited to ${LIMITS.replayImportBytes / 1048576} MB.`,
        },
      });
      return;
    }
    const text = await file.text();
    await analyze(text, file.size, file.name, true);
  };

  const replayData = localGame?.adapter.replayData?.() ?? null;
  const localFile = (): ReplayFile | null =>
    replayData
      ? buildReplayFile(engine, replayData, { displayName: null, createdAt: new Date().toISOString() })
      : null;

  if (state.kind === "ready") {
    return <ReplayPlayer engine={engine} replay={state.replay} onClose={() => setState({ kind: "idle" })} />;
  }

  return (
    <div className="stack">
      <section className="panel" aria-labelledby={`${id}-local`}>
        <h2 className="panel__title" id={`${id}-local`}>
          Your guest game
        </h2>
        {replayData && local.session ? (
          <>
            <p>
              {replayData.moves.length} accepted moves on the current path (undone moves are excluded). The
              replay is verified by the engine before it plays.
            </p>
            <div className="action-row">
              <button
                type="button"
                className="button button--primary"
                disabled={state.kind === "checking"}
                onClick={() => {
                  const file = localFile();
                  if (file) {
                    const text = JSON.stringify(file);
                    void analyze(text, new Blob([text]).size, "current game", false);
                  }
                }}
              >
                Watch replay
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  const file = localFile();
                  if (file) downloadJson(replayFileName(file), file);
                }}
              >
                Export replay file
              </button>
            </div>
          </>
        ) : (
          <p>
            No guest game with a replay record in this browser yet. Play a guest game (games started before
            this version have no move record).
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby={`${id}-import`} aria-busy={state.kind === "checking"}>
        <h2 className="panel__title" id={`${id}-import`}>
          Import a replay file
        </h2>
        <p>
          Files stay on this computer. Every move is re-checked against its checksum; imported replays are
          never ranked. Limit: {LIMITS.replayImportBytes / 1048576} MB and{" "}
          {LIMITS.replayMaxMoves.toLocaleString()} moves.
        </p>
        <div className="field">
          <label htmlFor={`${id}-file`}>Replay file (.json)</label>
          <input
            ref={fileRef}
            id={`${id}-file`}
            type="file"
            accept=".json,application/json"
            onChange={(e) => void onFile(e)}
          />
        </div>
        {state.kind === "checking" && <p role="status">Checking “{state.name}”…</p>}
        {state.kind === "error" && (
          <div className="notice notice--error" role="alert">
            <p>
              <strong>Can't open “{state.name}”.</strong> {state.problem.message}
            </p>
            <p>{PROBLEM_HELP[state.problem.kind]}</p>
            <button type="button" className="button button--small" onClick={() => fileRef.current?.click()}>
              Choose another file
            </button>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby={`${id}-server`}>
        <h2 className="panel__title" id={`${id}-server`}>
          Replay from the local server
        </h2>
        <p>
          Account games, challenge attempts and duels are replayed from the server&apos;s record (GET
          /replays/:id) and re-verified here before they play.
        </p>
        <form
          className="field-grid"
          aria-label="Load a replay from the server"
          onSubmit={(e) => {
            e.preventDefault();
            void loadServer();
          }}
        >
          <div className="field">
            <label htmlFor={`${id}-rid`}>Replay or game ID</label>
            <input
              id={`${id}-rid`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
            />
          </div>
          <div className="field field--end">
            <button type="submit" className="button" disabled={!serverId.trim() || state.kind === "checking"}>
              Load from server
            </button>
          </div>
        </form>
        {serverError && (
          <p className="notice notice--error" role="alert">
            {serverError}
          </p>
        )}
      </section>
    </div>
  );
}
