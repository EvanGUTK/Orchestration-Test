import type { Direction, GameState } from "@g2048/contracts";
import type { GameAdapter, GameSession, MoveOutcome, ReplayData, StartRequest } from "./adapter.js";

const LETTER: Record<Direction, string> = { up: "u", right: "r", down: "d", left: "l" };
const FROM_LETTER: Record<string, Direction> = { u: "up", r: "right", d: "down", l: "left" };
import type { EnginePort } from "./engine-port.js";
import { toEngineFailure } from "./engine-port.js";
import type { GuestSaveStore } from "./save-store.js";
import { canonicalGuestRules } from "./save-store.js";

export function randomSeed(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Guest/offline adapter: applies moves with the pure engine in the browser and autosaves the
 * canonical serialized state to a GuestSaveStore after every accepted move.
 * Undo keeps up to `rules.historyLimit` previous immutable states in memory (casual modes only).
 */
export function createLocalAdapter(engine: EnginePort, saves: GuestSaveStore): GameAdapter {
  let session: GameSession | null = null;
  let history: GameState[] = [];
  /** Replay record: initial state and the accepted moves on the final path (undo removes the last). */
  let initial: GameState | null = null;
  let path = "";

  function withState(state: GameState): GameSession {
    if (!session) throw new Error("No session");
    session = {
      ...session,
      state,
      undoDepth: history.length,
      canUndo: session.rules.undo && history.length > 0,
    };
    return session;
  }

  function persist() {
    if (!session) return;
    saves.save({
      version: 1,
      id: session.id,
      mode: session.mode,
      rules: session.rules,
      seed: session.seed,
      state: engine.serialize(session.state),
      savedAt: new Date().toISOString(),
      ...(initial ? { initial: engine.serialize(initial), path } : {}),
    });
  }

  // Resume the guest autosave, re-validating it with the engine. A corrupt save is ignored, not trusted.
  const saved = saves.load();
  if (saved) {
    try {
      const state = engine.deserialize(saved.state);
      const rules = canonicalGuestRules(saved.rules);
      if (rules && state.board.size === rules.size && state.rulesetVersion === rules.version) {
        session = {
          id: saved.id,
          mode: saved.mode,
          rules,
          seed: saved.seed,
          state,
          undoDepth: 0,
          canUndo: false,
          authority: "local",
        };
        if (saved.initial !== undefined && saved.path !== undefined) {
          try {
            initial = engine.deserialize(saved.initial);
            path = saved.path;
          } catch {
            initial = null;
            path = "";
          }
        }
      }
    } catch {
      session = null;
    }
  }

  return {
    kind: "local",
    current: () => session,
    async start(request: StartRequest) {
      const seed = request.seed ?? randomSeed();
      const state = engine.newGame(request.rules, seed);
      history = [];
      initial = state;
      path = "";
      session = {
        id: `local-${randomSeed(8)}`,
        mode: request.mode,
        rules: request.rules,
        seed,
        state,
        undoDepth: 0,
        canUndo: false,
        authority: "local",
      };
      persist();
      return session;
    },
    async move(direction: Direction): Promise<MoveOutcome> {
      if (!session) return { ok: false, code: "NOT_FOUND", message: "No game in progress." };
      if (session.state.status !== "active") {
        return { ok: false, code: "GAME_NOT_ACTIVE", message: "This game has ended." };
      }
      const before = session.state;
      let result;
      try {
        result = engine.applyMove(before, direction, session.rules);
      } catch (error) {
        // RESOURCE_LIMIT etc.: the last valid state is kept untouched.
        return { ok: false, ...toEngineFailure(error) };
      }
      if (result.changed) {
        if (session.rules.undo && session.rules.historyLimit > 0) {
          history = [...history, before].slice(-session.rules.historyLimit);
        }
        path += LETTER[direction];
        withState(result.state);
        persist();
      }
      return {
        ok: true,
        session,
        changed: result.changed,
        scoreDelta: result.scoreDelta,
        events: result.events,
      };
    },
    async undo() {
      if (!session || !session.rules.undo) return null;
      const previous = history.at(-1);
      if (!previous) return null;
      history = history.slice(0, -1);
      path = path.slice(0, -1);
      withState(previous);
      persist();
      return session;
    },
    async forfeit() {
      if (!session || session.state.status !== "active") return session;
      history = [];
      withState(engine.forfeit(session.state));
      persist();
      return session;
    },
    async reload() {
      return session;
    },
    replayData(): ReplayData | null {
      if (!session || !initial || session.seed === null) return null;
      return {
        mode: session.mode,
        rules: session.rules,
        seed: session.seed,
        initial,
        moves: [...path].map((c) => FROM_LETTER[c] as Direction),
      };
    },
    async discard() {
      session = null;
      history = [];
      initial = null;
      path = "";
      saves.clear();
    },
  };
}
