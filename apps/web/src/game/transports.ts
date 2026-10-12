import type { GameState, MoveCommand, Ruleset } from "@2048/contracts";
import { HISTORY_CAP } from "@2048/contracts";
import { ApiRequestError } from "../api/client.ts";
import type { ApiClient } from "../api/client.ts";
import { getEngine } from "../engine/port.ts";
import { newId } from "../api/ids.ts";
import type { GameTransport, MoveOutcome } from "./controller.ts";

/** Casual in-browser play: the pure engine is the authority; nothing is ranked or sent anywhere. */
export class LocalTransport implements GameTransport {
  readonly kind = "local" as const;
  private history: GameState[] = [];
  private current: GameState;
  private readonly rules: Ruleset;
  private readonly onChange: ((state: GameState) => void) | undefined;
  constructor(initial: GameState, rules: Ruleset, onChange?: (state: GameState) => void) {
    this.current = initial;
    this.rules = rules;
    this.onChange = onChange;
  }

  async move(command: MoveCommand, current: GameState): Promise<MoveOutcome> {
    if (command.expectedRevision !== current.revision) {
      throw new ApiRequestError("REVISION_CONFLICT", "Stale local revision.", 409, null);
    }
    const result = getEngine().applyMove(current, command.direction, this.rules);
    if (result.changed) {
      this.history.push(current);
      if (this.history.length > Math.min(HISTORY_CAP, this.rules.undoLimit || HISTORY_CAP)) this.history.shift();
      this.current = result.state;
      this.onChange?.(result.state);
    }
    return { ...result, undoAvailable: this.history.length };
  }

  async load(): Promise<{ state: GameState; undoAvailable: number }> {
    return { state: this.current, undoAvailable: this.history.length };
  }

  async undo(current: GameState): Promise<{ state: GameState; undoAvailable: number }> {
    const previous = this.history.pop();
    if (!previous) return { state: current, undoAvailable: 0 };
    // Keep revision monotone like the service does: restored board/PRNG/score, new revision.
    const restored: GameState = { ...previous, revision: current.revision + 1 };
    this.current = restored;
    this.onChange?.(restored);
    return { state: restored, undoAvailable: this.history.length };
  }
}

/** Server-authoritative play with commandId idempotency and optimistic revisions. */
export class RemoteTransport implements GameTransport {
  readonly kind = "remote" as const;
  private readonly client: ApiClient;
  private readonly gameId: string;
  readonly undo: ((current: GameState) => Promise<{ state: GameState; undoAvailable: number }>) | undefined;

  constructor(client: ApiClient, gameId: string, allowUndo = false) {
    this.client = client;
    this.gameId = gameId;
    this.undo = allowUndo
      ? async (current) => {
          const response = await client.undo(gameId, { commandId: newId(), expectedRevision: current.revision });
          return { state: response.game.state, undoAvailable: response.game.undoAvailable };
        }
      : undefined;
  }

  async move(command: MoveCommand): Promise<MoveOutcome> {
    const response = await this.client.move(this.gameId, command);
    return {
      state: response.game.state,
      changed: response.changed,
      scoreDelta: response.scoreDelta,
      events: response.events,
      undoAvailable: response.game.undoAvailable,
    };
  }

  async load(): Promise<{ state: GameState; undoAvailable: number }> {
    const game = await this.client.getGame(this.gameId);
    return { state: game.state, undoAvailable: game.undoAvailable };
  }

}
