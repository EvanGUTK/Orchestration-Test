import { useEffect, useMemo, useState } from "react";
import type { GameState, GameView, Ruleset } from "@2048/contracts";
import { CLASSIC_RULES, customRules, resolveRules } from "@2048/contracts";
import { newId, newSeed } from "../api/ids.ts";
import { useRealtime } from "../api/realtime.ts";
import { EmptyState, ErrorPanel, PageHeading, Spinner } from "../components/common.tsx";
import { GamePlay } from "../components/GamePlay.tsx";
import { getEngine, isEngineAvailable } from "../engine/port.ts";
import { GameController } from "../game/controller.ts";
import { useGameController } from "../game/hooks.ts";
import { LocalTransport, RemoteTransport } from "../game/transports.ts";
import { Link, useNavigate, useRoute } from "../router.tsx";
import { useApp } from "../state/app.tsx";
import { clearGuestGame, loadGuestGame, saveGuestGame } from "../state/guestSave.ts";
import type { GuestSave } from "../state/guestSave.ts";
import { useAsync } from "../state/useAsync.ts";

function rulesFromParams(params: URLSearchParams): { rules: Ruleset; mode: "classic" | "practice"; seed: string } {
  const sizeParam = params.get("size");
  const seed = params.get("seed")?.trim() || newSeed();
  if (sizeParam === null) return { rules: CLASSIC_RULES, mode: "classic", seed };
  const fours = params.get("fours");
  const rules = customRules({
    boardSize: Number(sizeParam),
    ...(fours !== null && fours !== "" ? { spawnFourTenths: Number(fours) } : {}),
  });
  return { rules, mode: "practice", seed };
}

/** Guest / local casual play: the engine runs in the browser, nothing leaves the machine. */
export function LocalPlayScreen() {
  const route = useRoute();
  const key = route.params.toString();
  return <LocalPlay key={key} params={route.params} />;
}

function LocalPlay(props: { params: URLSearchParams }) {
  const navigate = useNavigate();
  const [setup] = useState<{ save: GuestSave } | { error: unknown }>(() => {
    try {
      if (!isEngineAvailable()) return { error: new Error("The game engine is not part of this build yet.") };
      const wantsNew = props.params.get("new") === "1";
      if (!wantsNew) {
        const saved = loadGuestGame();
        if (saved && saved.state.status === "active") return { save: saved };
      }
      const { rules, mode, seed } = rulesFromParams(props.params);
      const state = getEngine().newGame(rules, seed);
      return { save: { seed, mode, rules, state, updatedAt: new Date().toISOString() } };
    } catch (error) {
      return { error };
    }
  });

  useEffect(() => {
    if ("save" in setup) {
      saveGuestGame(setup.save);
      if (props.params.get("new") === "1") window.history.replaceState(null, "", "#/play");
    }
  }, [setup, props.params]);

  if ("error" in setup) {
    return (
      <>
        <PageHeading title="Guest game" />
        <ErrorPanel error={setup.error} onRetry={() => navigate(`/play?new=1&t=${Date.now()}`)} />
      </>
    );
  }
  return <LocalGame save={setup.save} />;
}

function LocalGame(props: { save: GuestSave }) {
  const { save } = props;
  const navigate = useNavigate();
  const controller = useGameController(`${save.seed}:${save.rules.version}`, () => {
    const transport = new LocalTransport(save.state, save.rules, (state: GameState) =>
      saveGuestGame({ ...save, state, updatedAt: new Date().toISOString() }),
    );
    return new GameController(save.state, transport);
  });
  const title = save.mode === "practice" ? `Practice ${save.rules.boardSize}x${save.rules.boardSize}` : "Classic infinite (guest)";
  return (
    <>
      <PageHeading title={title} subtitle="Casual. Saved in this browser only, never ranked." />
      <GamePlay
        controller={controller}
        label={title}
        showUndo
        onFinished={() => clearGuestGame()}
        actions={
          <>
            <button type="button" className="btn" onClick={() => navigate(`/play?new=1&t=${Date.now()}`)}>
              New classic game
            </button>
            <Link to="/practice" className="btn">
              Custom practice
            </Link>
          </>
        }
        statusNote={`Seed ${save.seed}`}
      />
    </>
  );
}

/** Server-authoritative game. */
export function RemotePlayScreen(props: { id: string }) {
  const { api, identity } = useApp();
  const game = useAsync((signal) => api.getGame(props.id, signal), [api, props.id]);
  if (!identity) {
    return (
      <EmptyState title="Sign in to open this game">
        <Link to="/login">Sign in</Link> to resume server games.
      </EmptyState>
    );
  }
  if (game.status === "loading") return <Spinner label="Loading game" />;
  if (game.status === "error") return <ErrorPanel error={game.error} onRetry={game.reload} />;
  return <RemoteGame view={game.data} />;
}

export function modeTitle(view: GameView): string {
  switch (view.mode) {
    case "classic":
      return "Classic infinite";
    case "practice":
      return `Practice ${view.state.board.size}x${view.state.board.size}`;
    case "ranked":
      return "Ranked challenge";
    case "duel":
      return "Duel seat";
    default:
      return view.mode;
  }
}

function RemoteGame(props: { view: GameView }) {
  const { view } = props;
  const { api } = useApp();
  const navigate = useNavigate();
  const casual = view.mode === "classic" || view.mode === "practice";
  const controller = useGameController(view.id, () => new GameController(view.state, new RemoteTransport(api, view.id, casual), { undoAvailable: view.undoAvailable }));
  const rules = useMemo(() => resolveRules(view.rulesetVersion), [view.rulesetVersion]);
  const [confirm, setConfirm] = useState(false);
  const [forfeitError, setForfeitError] = useState<unknown>(null);

  useRealtime(
    [view.id],
    (envelope) => {
      if (envelope.type === "game.updated") {
        const payload = envelope.payload as { game?: GameView; state?: GameState };
        const state = payload.game?.state ?? payload.state;
        if (state) controller.receive(state, payload.game?.undoAvailable);
      }
    },
    () => {
      api.getGame(view.id).then(
        (fresh) => controller.receive(fresh.state, fresh.undoAvailable),
        () => undefined,
      );
    },
  );

  const forfeit = async () => {
    setForfeitError(null);
    try {
      await api.forfeit(view.id, { commandId: newId(), expectedRevision: controller.getSnapshot().state.revision });
      await controller.reload();
      setConfirm(false);
    } catch (error) {
      setForfeitError(error);
    }
  };

  const official = view.mode === "ranked" || view.mode === "duel";
  return (
    <>
      <PageHeading title={modeTitle(view)} subtitle={official ? "Official rules: no undo, 500 accepted moves. Abandoning forfeits." : "Saved on the local server."} />
      <GamePlay
        controller={controller}
        label={modeTitle(view)}
        showUndo={casual}
        moveCap={rules?.moveCap ?? null}
        statusNote={view.seed ? `Seed ${view.seed}` : "Seed hidden until the attempt ends"}
        actions={
          <>
            {official ? (
              confirm ? (
                <>
                  <button type="button" className="btn btn-danger" onClick={() => void forfeit()}>
                    Confirm forfeit
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirm(false)}>
                    Keep playing
                  </button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => setConfirm(true)}>
                  Forfeit
                </button>
              )
            ) : null}
            <button type="button" className="btn" onClick={() => navigate("/saves")}>
              Saved games
            </button>
          </>
        }
      />
      {forfeitError ? <ErrorPanel error={forfeitError} onRetry={() => void forfeit()} /> : null}
      {view.state.status !== "active" ? (
        <p>
          <Link to={`/replays/${view.id}`}>Open the replay</Link>
        </p>
      ) : null}
    </>
  );
}
