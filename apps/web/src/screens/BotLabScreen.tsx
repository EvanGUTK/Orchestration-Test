import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import {
  BOT_DIFFICULTY,
  BOT_STRATEGIES,
  BotConfigSchema,
  LIMITS,
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
} from "@g2048/contracts";
import type { BotStrategy, Direction } from "@g2048/contracts";
import { useAuth, useServices, useSettings } from "../app/services.js";
import { Board } from "../components/Board.js";
import { ScoreDisplay, Stat } from "../components/ScoreDisplay.js";
import { TileText } from "../components/Tile.js";
import { LocalBotRun, rulesForBotRun } from "../bots/local-run.js";
import type { BotRunHandle } from "../bots/local-run.js";
import { httpBotRunApi, ServerBotRun } from "../bots/server-run.js";
import { randomSeed } from "../game/local-adapter.js";
import { highestExponent } from "./PlayScreen.js";

const STRATEGY_INFO: Record<BotStrategy, { name: string; about: string; nodes: number }> = {
  "random-v1": { name: "Random", about: "Picks any legal move.", nodes: 1 },
  "greedy-v1": { name: "Greedy", about: "Takes the move with the biggest immediate merge score.", nodes: 16 },
  "heuristic-v1": {
    name: "Heuristic",
    about: "Short search scoring empty cells, smoothness and corners.",
    nodes: 20_000,
  },
  "expectimax-v1": {
    name: "Expectimax",
    about: "Bounded search averaging over possible spawns.",
    nodes: 200_000,
  },
};
const ARROW: Record<Direction, string> = { up: "↑", right: "→", down: "↓", left: "←" };
const STATUS_TEXT = {
  ready: "Ready",
  running: "Running",
  paused: "Paused",
  finished: "Finished",
  cancelled: "Stopped",
  failed: "Failed",
} as const;

function RunView({ run, onReset }: { run: BotRunHandle; onReset: () => void }) {
  const settings = useSettings();
  const view = useSyncExternalStore(run.subscribe, run.get, run.get);
  // Leaving the screen stops the run (and its worker search). Deferred so StrictMode's dev-only
  // unmount/remount cycle doesn't stop a run that is still on screen.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current) run.stop();
      }, 0);
    };
  }, [run]);
  const top = highestExponent(view.state);
  const ended = view.status === "finished" || view.status === "cancelled" || view.status === "failed";
  const decision = view.lastDecision;

  return (
    <section className="panel" aria-label="Bot run" aria-busy={view.thinking}>
      <p className="eyebrow">
        Bot exhibition · {run.kind === "local" ? "running in this browser" : "running on the server"} ·
        casual, never ranked against people
      </p>
      <div className="stats">
        <ScoreDisplay label="Score" value={view.state.score} />
        <Stat label="Moves" value={String(view.movesPlayed)} />
        <Stat label="Top" value={top ? <TileText exponent={top} style={settings.tileDisplay} /> : "—"} />
      </div>
      <Board
        board={view.state.board}
        tileStyle={settings.tileDisplay}
        bindings={settings.keyBindings}
        label={`Bot game board, ${view.rules.size} by ${view.rules.size}`}
      />
      <p role="status" className="hint">
        <strong>{STATUS_TEXT[view.status]}</strong>
        {view.thinking ? " · thinking…" : ""}
        {view.message ? ` · ${view.message}` : ""}
      </p>
      <div className="bot-decision" aria-label="Last decision">
        {decision ? (
          <>
            <p className="bot-decision__move">
              Chose <strong>{decision.direction}</strong>{" "}
              <span aria-hidden="true">{ARROW[decision.direction]}</span>
              {decision.fallback && <span className="badge badge--pending">budget fallback</span>}
            </p>
            <p>{decision.explanation}</p>
            <p className="hint hint--small">
              {decision.nodesSearched.toLocaleString()} nodes searched · {decision.botVersion}
            </p>
          </>
        ) : (
          <p className="hint">No moves yet.</p>
        )}
      </div>
      <div className="action-row">
        {!ended &&
          (view.status === "running" ? (
            run.canPause && (
              <button type="button" className="button button--primary" onClick={() => run.pause()}>
                Pause
              </button>
            )
          ) : (
            <button type="button" className="button button--primary" onClick={() => run.run()}>
              {view.status === "paused" ? "Resume" : "Run"}
            </button>
          ))}
        {!ended && run.canPause && (
          <button type="button" className="button" onClick={() => void run.step()} disabled={view.thinking}>
            Step one move
          </button>
        )}
        {!ended && (
          <button type="button" className="button button--danger" onClick={() => run.stop()}>
            Stop
          </button>
        )}
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            run.stop();
            onReset();
          }}
        >
          New run
        </button>
      </div>
    </section>
  );
}

export function BotLabScreen() {
  const { engine, decisions, api, events, settings: store } = useServices();
  const settings = useSettings();
  const auth = useAuth();
  const id = useId();
  const [strategy, setStrategy] = useState<BotStrategy>("greedy-v1");
  const [nodeBudget, setNodeBudget] = useState(String(STRATEGY_INFO["greedy-v1"].nodes));
  const [timeBudgetMs, setTimeBudgetMs] = useState("1000");
  const [seed, setSeed] = useState(() => randomSeed(6));
  const [size, setSize] = useState("4");
  const [maxMoves, setMaxMoves] = useState("1000");
  const [where, setWhere] = useState<"local" | "server">(() =>
    engine !== null && decisions !== null ? "local" : "server",
  );
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<BotRunHandle | null>(null);

  const localAvailable = engine !== null && decisions !== null;
  const serverAvailable = auth.status === "signed-in" && engine !== null;

  if (run) return <RunView run={run} onReset={() => setRun(null)} />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const config = BotConfigSchema.safeParse({
      strategy,
      nodeBudget: Number(nodeBudget),
      timeBudgetMs: Number(timeBudgetMs),
    });
    const n = Number(size);
    const cap = Number(maxMoves);
    if (!config.success) {
      setError(
        `Node budget must be 1–${LIMITS.botNodeBudgetMax.toLocaleString()} and time budget 1–${LIMITS.botTimeBudgetMsMax.toLocaleString()} ms (whole numbers).`,
      );
      return;
    }
    if (!seed.trim() || seed.length > 128) {
      setError("Enter a seed of 1–128 characters.");
      return;
    }
    if (!Number.isInteger(cap) || cap < 1 || cap > 100_000) {
      setError("Move limit must be a whole number from 1 to 100,000.");
      return;
    }
    setError(null);
    const runSettings = { ...config.data, seed: seed.trim(), size: n, maxMoves: cap };
    if (where === "server" && serverAvailable && engine) {
      const initial = engine.newGame(rulesForBotRun(n), runSettings.seed);
      setRun(new ServerBotRun(httpBotRunApi(api), events, runSettings, initial));
    } else if (engine && decisions) {
      setRun(new LocalBotRun(engine, decisions, runSettings, () => store.get().botSpeedMs));
    }
  };

  if (!localAvailable && !serverAvailable) {
    return (
      <section className="panel panel--unavailable">
        <p className="badge badge--pending">Not available yet</p>
        <p>
          Bots need the game engine and Web Worker support in this browser, or a signed-in account on the
          server.
        </p>
      </section>
    );
  }

  return (
    <form className="panel form" onSubmit={submit} noValidate aria-describedby={`${id}-about`}>
      <p className="lede" id={`${id}-about`}>
        Watch deterministic bots play. Search runs in a background worker with strict node and time budgets,
        so the page stays responsive. Bot results never touch human rankings.
      </p>

      <fieldset className="field">
        <legend>Strategy</legend>
        <div className="choice-list">
          {BOT_STRATEGIES.map((s) => (
            <label key={s} className="choice">
              <input
                type="radio"
                name="strategy"
                value={s}
                checked={strategy === s}
                onChange={() => {
                  setStrategy(s);
                  setNodeBudget(String(STRATEGY_INFO[s].nodes));
                }}
              />
              <span>
                <strong>
                  {STRATEGY_INFO[s].name} <span className="badge">{BOT_DIFFICULTY[s]}</span>
                </strong>
                <span className="hint hint--small">{STRATEGY_INFO[s].about}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field-grid">
        <div className="field">
          <label htmlFor={`${id}-nodes`}>Node budget per move</label>
          <input
            id={`${id}-nodes`}
            type="number"
            inputMode="numeric"
            min={1}
            max={LIMITS.botNodeBudgetMax}
            value={nodeBudget}
            onChange={(e) => setNodeBudget(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-time`}>Time budget per move (ms)</label>
          <input
            id={`${id}-time`}
            type="number"
            inputMode="numeric"
            min={1}
            max={LIMITS.botTimeBudgetMsMax}
            value={timeBudgetMs}
            onChange={(e) => setTimeBudgetMs(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-seed`}>Seed</label>
          <input
            id={`${id}-seed`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-size`}>Board</label>
          <select id={`${id}-size`} value={size} onChange={(e) => setSize(e.target.value)}>
            {Array.from({ length: MAX_BOARD_SIZE - MIN_BOARD_SIZE + 1 }, (_, i) => MIN_BOARD_SIZE + i).map(
              (n) => (
                <option key={n} value={n}>
                  {n}×{n}
                  {n === 4 ? " (bot-v1)" : " (practice)"}
                </option>
              ),
            )}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-max`}>Stop after (moves)</label>
          <input
            id={`${id}-max`}
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            value={maxMoves}
            onChange={(e) => setMaxMoves(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${id}-speed`}>Playback speed (delay between moves)</label>
        <div className="range-row">
          <input
            id={`${id}-speed`}
            type="range"
            min={0}
            max={5000}
            step={100}
            value={settings.botSpeedMs}
            onChange={(e) => store.update({ botSpeedMs: Number.parseInt(e.target.value, 10) })}
            aria-valuetext={`${settings.botSpeedMs} milliseconds per move`}
          />
          <output htmlFor={`${id}-speed`}>
            {settings.botSpeedMs === 0 ? "Instant" : `${settings.botSpeedMs} ms`}
          </output>
        </div>
      </div>

      <fieldset className="field">
        <legend>Run on</legend>
        <div className="segmented">
          <label className="segmented__item">
            <input
              type="radio"
              name="where"
              checked={where === "local"}
              disabled={!localAvailable}
              onChange={() => setWhere("local")}
            />
            <span>This browser (offline)</span>
          </label>
          <label className="segmented__item">
            <input
              type="radio"
              name="where"
              checked={where === "server"}
              disabled={!serverAvailable}
              onChange={() => setWhere("server")}
            />
            <span>Local server</span>
          </label>
        </div>
        {!serverAvailable && <p className="hint hint--small">Server runs need a signed-in account.</p>}
      </fieldset>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <div className="action-row">
        <button type="submit" className="button button--primary">
          Set up run
        </button>
      </div>
    </form>
  );
}
