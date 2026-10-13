import { PRACTICE_RULESET_VERSION, RULESETS, practiceRuleset } from "@g2048/contracts";
import type { Direction, GameMode, GameResponse, GameState, MoveResponse, Ruleset } from "@g2048/contracts";
import type { ApiClient, Sleep } from "../api/client.js";
import { ApiError, describeApiError, isApiError, newCommandId, realSleep, withRetry } from "../api/client.js";
import type { GameAdapter, GameSession, MoveFailure, MoveOutcome, StartRequest } from "./adapter.js";

type PendingCommand = { commandId: string; direction: Direction; expectedRevision: number };

export type ServerAdapterOptions = {
  sleep?: Sleep;
  /** Called on 401 so the app can switch to a signed-out state and prompt sign-in. */
  onUnauthenticated?: () => void;
  delays?: readonly number[];
};

/**
 * Display-side ruleset for a server game. The server applies the real ruleset; the client only needs
 * size/undo for presentation. Practice games resumed from the list don't expose fourWeight/undo, so we
 * assume undo is allowed and rely on the server's `canUndo`.
 */
export function rulesForServerGame(mode: GameMode, state: GameState, hint?: Ruleset): Ruleset {
  if (hint && hint.version === state.rulesetVersion && hint.size === state.board.size) return hint;
  const builtin = (RULESETS as Record<string, Ruleset>)[state.rulesetVersion];
  if (builtin) return builtin;
  if (state.rulesetVersion === PRACTICE_RULESET_VERSION || mode === "practice") {
    return practiceRuleset({ size: state.board.size, fourWeight: 1, undo: true });
  }
  return { ...RULESETS["classic-v1"], version: state.rulesetVersion, size: state.board.size, undo: false };
}

function isGameState(value: unknown): value is GameState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.revision === "number" &&
    typeof v.score === "string" &&
    typeof v.status === "string" &&
    typeof v.board === "object" &&
    v.board !== null
  );
}

/**
 * Account play against the authoritative local server (CONTRACT-001 HTTP).
 *
 * Exactly-once moves: every move gets a client commandId (crypto.randomUUID) and the expected
 * revision. Transient failures (network, DB_BUSY, RESOURCE_LIMIT) are retried with backoff using the
 * SAME commandId; if retries run out the command stays "unresolved" and is re-sent with the same
 * commandId later, so a request that reached the server but lost its response is never applied twice.
 * A REVISION_CONFLICT (state changed elsewhere) refetches the game and replays the move once with a
 * fresh commandId against the new revision; the rejected command had no effect.
 */
export class ServerGameAdapter implements GameAdapter {
  readonly kind = "server" as const;
  private session: GameSession | null = null;
  private unresolved: PendingCommand | null = null;
  private readonly sleep: Sleep;

  constructor(
    private readonly api: ApiClient,
    private readonly options: ServerAdapterOptions = {},
  ) {
    this.sleep = options.sleep ?? realSleep;
  }

  current(): GameSession | null {
    return this.session;
  }

  /** Command waiting to be re-sent after a connection loss (exposed for tests and the UI). */
  get pendingCommand(): PendingCommand | null {
    return this.unresolved;
  }

  private retry<T>(op: () => Promise<T>): Promise<T> {
    return withRetry(op, this.api.connection, this.sleep, this.options.delays);
  }

  private fromResponse(res: GameResponse, hint?: Ruleset, seed: string | null = null): GameSession {
    if (!res || !isGameState(res.state) || !res.game) {
      throw new ApiError("BAD_RESPONSE", "Malformed game response", 200, null);
    }
    const rules = rulesForServerGame(res.game.mode, res.state, hint);
    return {
      id: res.game.id,
      mode: res.game.mode,
      rules,
      seed,
      state: res.state,
      canUndo: Boolean(res.canUndo) && rules.undo,
      undoDepth: null,
      authority: "server",
    };
  }

  private failure(error: unknown): MoveFailure {
    if (isApiError(error)) {
      if (error.code === "UNAUTHENTICATED") this.options.onUnauthenticated?.();
      return {
        ok: false,
        code: error.code,
        message: describeApiError(error),
        retryable: error.transient,
        requestId: error.requestId,
      };
    }
    return { ok: false, code: "INTERNAL_ERROR", message: "Unexpected error.", retryable: false };
  }

  async start(request: StartRequest): Promise<GameSession> {
    const body =
      request.mode === "practice"
        ? {
            mode: "practice" as const,
            practice: {
              size: request.rules.size,
              fourWeight: request.rules.fourWeight,
              undo: request.rules.undo,
              ...(request.seed ? { seed: request.seed } : {}),
            },
          }
        : { mode: "classic" as const };
    // Creating a game is not idempotent, so it is attempted once; the UI offers an explicit retry.
    const res = await this.api.createGame(body);
    this.unresolved = null;
    this.session = this.fromResponse(res, request.rules, request.seed ?? null);
    return this.session;
  }

  /** Adopts a game the server just created elsewhere (e.g. a challenge attempt). */
  adopt(res: GameResponse): GameSession {
    this.unresolved = null;
    this.session = this.fromResponse(res);
    return this.session;
  }

  /** Opens (resumes) a saved server game by ID. */
  async open(id: string): Promise<GameSession> {
    const res = await this.retry(() => this.api.getGame(id));
    this.unresolved = null;
    this.session = this.fromResponse(res);
    return this.session;
  }

  async reload(): Promise<GameSession | null> {
    if (!this.session) return null;
    const hint = this.session.rules;
    const seed = this.session.seed;
    const res = await this.retry(() => this.api.getGame(this.session!.id));
    this.unresolved = null;
    this.session = this.fromResponse(res, hint, seed);
    return this.session;
  }

  async move(direction: Direction): Promise<MoveOutcome> {
    return this.moveOnce(direction, false);
  }

  private async moveOnce(direction: Direction, afterConflict: boolean): Promise<MoveOutcome> {
    const session = this.session;
    if (!session) return { ok: false, code: "NOT_FOUND", message: "No game in progress." };

    // A different command than the unresolved one: settle the unresolved one first by reading the truth.
    if (this.unresolved && this.unresolved.direction !== direction) {
      try {
        await this.reload();
      } catch (error) {
        return this.failure(error);
      }
      return this.moveOnce(direction, afterConflict);
    }
    if (this.session!.state.status !== "active") {
      return { ok: false, code: "GAME_NOT_ACTIVE", message: "This game has ended." };
    }

    const command: PendingCommand = this.unresolved ?? {
      commandId: newCommandId(),
      direction,
      expectedRevision: this.session!.state.revision,
    };
    this.unresolved = command;
    let res: MoveResponse;
    try {
      res = await this.retry(() => this.api.move(session.id, command));
    } catch (error) {
      if (isApiError(error) && error.transient) return this.failure(error); // keep `unresolved`
      this.unresolved = null;
      if (isApiError(error) && error.code === "REVISION_CONFLICT" && !afterConflict) {
        try {
          await this.reload();
        } catch (reloadError) {
          return this.failure(reloadError);
        }
        return this.moveOnce(direction, true);
      }
      return this.failure(error);
    }
    this.unresolved = null;
    if (!res || typeof res.changed !== "boolean" || !isGameState(res.state)) {
      return { ok: false, code: "BAD_RESPONSE", message: "The server sent an unexpected response." };
    }
    if (res.state.revision < this.session!.state.revision) {
      // Never regress to an older state; read the authoritative one instead.
      await this.reload().catch(() => undefined);
      return { ok: false, code: "REVISION_CONFLICT", message: "The game was reloaded from the server." };
    }
    const rules = this.session!.rules;
    this.session = {
      ...this.session!,
      state: res.state,
      canUndo: res.changed ? rules.undo && res.state.status === "active" : this.session!.canUndo,
    };
    return {
      ok: true,
      session: this.session,
      changed: res.changed,
      scoreDelta: res.scoreDelta ?? "0",
      events: res.changed ? (res.events ?? []) : [],
    };
  }

  private async revisionCommand(
    send: (
      id: string,
      body: { commandId: string; expectedRevision: number },
    ) => Promise<Partial<GameResponse> & Partial<MoveResponse>>,
  ): Promise<GameSession | null> {
    const session = this.session;
    if (!session) return null;
    if (this.unresolved) await this.reload();
    const body = { commandId: newCommandId(), expectedRevision: this.session!.state.revision };
    try {
      const res = await this.retry(() => send(session.id, body));
      if (!isGameState(res?.state)) return this.reload();
      const rules = this.session!.rules;
      this.session = {
        ...this.session!,
        state: res.state,
        canUndo:
          typeof res.canUndo === "boolean"
            ? res.canUndo && rules.undo
            : rules.undo && res.state.acceptedMoves > 0 && res.state.status === "active",
      };
      return this.session;
    } catch (error) {
      if (isApiError(error) && error.code === "UNAUTHENTICATED") this.options.onUnauthenticated?.();
      if (isApiError(error) && error.code === "REVISION_CONFLICT") await this.reload().catch(() => undefined);
      throw error;
    }
  }

  undo(): Promise<GameSession | null> {
    if (!this.session?.rules.undo) return Promise.resolve(null);
    return this.revisionCommand((id, body) => this.api.undo(id, body));
  }

  forfeit(): Promise<GameSession | null> {
    if (!this.session || this.session.state.status !== "active") return Promise.resolve(this.session);
    return this.revisionCommand((id, body) => this.api.forfeit(id, body));
  }

  async discard(): Promise<void> {
    this.session = null;
    this.unresolved = null;
  }
}
