import type { Decimal, Direction, DomainEvent, GameState, MoveCommand } from "@2048/contracts";
import { newId } from "../api/ids.ts";
import { isApiError } from "../api/client.ts";
import { advanceTiles, createIdSource, layoutMatchesBoard, tilesFromBoard } from "./tiles.ts";
import type { IdSource, TileView } from "./tiles.ts";

export type MoveOutcome = {
  state: GameState;
  changed: boolean;
  scoreDelta: Decimal;
  events: DomainEvent[];
  undoAvailable?: number;
};

/** Where authoritative transitions come from: the in-browser engine (guest) or the server. */
export type GameTransport = {
  move(command: MoveCommand, current: GameState): Promise<MoveOutcome>;
  /** Fetch the authoritative state (used after a revision conflict or when the user presses reload). */
  load(): Promise<{ state: GameState; undoAvailable?: number }>;
  undo?(current: GameState): Promise<{ state: GameState; undoAvailable?: number }>;
  readonly kind: "local" | "remote";
};

export type LastMove = {
  seq: number; // increments once per processed command
  direction: Direction;
  changed: boolean;
  scoreDelta: Decimal;
  events: DomainEvent[];
};

export type ControllerSnapshot = {
  state: GameState;
  tiles: TileView[];
  lastMove: LastMove | null;
  pending: number;
  syncing: boolean;
  error: unknown | null;
  celebrate: boolean;
  undoAvailable: number;
};

export type ControllerOptions = {
  maxQueue?: number;
  maxNetworkRetries?: number;
  retryDelayMs?: number;
  maxConflictRetries?: number;
  newCommandId?: () => string;
};

const CELEBRATION_EXPONENT = "11";

/**
 * Serialises player input. Moves are applied strictly in the order they were
 * accepted into the FIFO queue, one in flight at a time, each with its own
 * idempotency key. Network failures retry the SAME command (safe: the server
 * dedupes by commandId); revision conflicts reload and re-issue a NEW command.
 * Nothing here is authoritative: every state comes from the transport.
 */
export class GameController {
  private snap: ControllerSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly queue: Direction[] = [];
  private inflight: MoveCommand | null = null;
  private running = false;
  private disposed = false;
  private seq = 0;
  private readonly ids: IdSource = createIdSource();
  private readonly opts: Required<ControllerOptions>;
  private readonly transport: GameTransport;

  constructor(initial: GameState, transport: GameTransport, options: ControllerOptions & { undoAvailable?: number } = {}) {
    this.transport = transport;
    this.opts = {
      maxQueue: options.maxQueue ?? 8,
      maxNetworkRetries: options.maxNetworkRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 400,
      maxConflictRetries: options.maxConflictRetries ?? 3,
      newCommandId: options.newCommandId ?? newId,
    };
    this.snap = {
      state: initial,
      tiles: tilesFromBoard(initial.board, this.ids),
      lastMove: null,
      pending: 0,
      syncing: false,
      error: null,
      celebrate: false,
      undoAvailable: options.undoAvailable ?? 0,
    };
  }

  // useSyncExternalStore contract -------------------------------------------------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): ControllerSnapshot => this.snap;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<ControllerSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Queue a move. Returns false if it was rejected without being queued (inactive game, full queue). */
  enqueue(direction: Direction): boolean {
    if (this.disposed || this.snap.state.status !== "active") return false;
    if (this.snap.error !== null) return false;
    if (this.queue.length >= this.opts.maxQueue) return false;
    this.queue.push(direction);
    this.set({ pending: this.queue.length });
    void this.pump();
    return true;
  }

  dismissCelebration(): void {
    if (this.snap.celebrate) this.set({ celebrate: false });
  }

  /** Clear an error and resume processing whatever is still queued. */
  retry(): void {
    if (this.snap.error === null) return;
    this.set({ error: null });
    void this.pump();
  }

  /** Discard queued input and reload the authoritative state. */
  async reload(): Promise<void> {
    this.queue.length = 0;
    this.inflight = null;
    this.set({ pending: 0, syncing: true });
    try {
      const loaded = await this.transport.load();
      this.adopt(loaded.state, loaded.undoAvailable);
      this.set({ error: null, syncing: false });
    } catch (error) {
      this.set({ error, syncing: false });
    }
  }

  /** Accept a newer authoritative state pushed from elsewhere (WebSocket snapshot). Never regresses. */
  receive(state: GameState, undoAvailable?: number): void {
    if (this.disposed || this.running || this.queue.length > 0) return;
    if (state.revision <= this.snap.state.revision) return;
    this.adopt(state, undoAvailable);
  }

  async undo(): Promise<void> {
    if (!this.transport.undo || this.running || this.queue.length > 0) return;
    this.running = true;
    this.set({ syncing: true });
    try {
      const result = await this.transport.undo(this.snap.state);
      this.adopt(result.state, result.undoAvailable);
      this.set({ error: null });
    } catch (error) {
      this.set({ error });
    } finally {
      this.running = false;
      this.set({ syncing: false });
    }
    void this.pump();
  }

  private adopt(state: GameState, undoAvailable?: number): void {
    const tiles = layoutMatchesBoard(this.snap.tiles, state.board) ? this.snap.tiles : tilesFromBoard(state.board, this.ids);
    this.set({
      state,
      tiles: tiles.map((t) => ({ ...t, fresh: false, merged: false })).filter((t) => !t.leaving),
      undoAvailable: undoAvailable ?? this.snap.undoAvailable,
    });
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    let networkAttempts = 0;
    let conflicts = 0;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const direction = this.queue[0] as Direction;
        const command: MoveCommand =
          this.inflight && this.inflight.direction === direction
            ? this.inflight
            : { commandId: this.opts.newCommandId(), expectedRevision: this.snap.state.revision, direction };
        this.inflight = command;
        this.set({ syncing: this.transport.kind === "remote" });
        let outcome: MoveOutcome;
        try {
          outcome = await this.transport.move(command, this.snap.state);
        } catch (error) {
          if (this.disposed) return;
          if (isApiError(error) && error.isNetwork && networkAttempts < this.opts.maxNetworkRetries) {
            networkAttempts++;
            await new Promise((resolve) => setTimeout(resolve, this.opts.retryDelayMs * networkAttempts));
            continue; // same command, same commandId
          }
          if (isApiError(error) && error.code === "REVISION_CONFLICT" && conflicts < this.opts.maxConflictRetries) {
            conflicts++;
            const loaded = await this.transport.load();
            this.inflight = null;
            this.adopt(loaded.state, loaded.undoAvailable);
            if (loaded.state.status !== "active") this.queue.length = 0;
            this.set({ pending: this.queue.length });
            continue; // new command, fresh expectedRevision
          }
          // Unknown outcome or hard failure: stop and let the player decide; keep the in-flight command.
          const hard = !(isApiError(error) && (error.isNetwork || error.code === "REVISION_CONFLICT" || error.code === "DB_BUSY" || error.code === "RATE_LIMITED"));
          if (hard) {
            this.inflight = null;
            this.queue.length = 0;
          }
          this.set({ error, syncing: false, pending: this.queue.length });
          return;
        }
        networkAttempts = 0;
        conflicts = 0;
        this.inflight = null;
        this.queue.shift();
        this.applyOutcome(direction, outcome);
        if (outcome.state.status !== "active") this.queue.length = 0;
        this.set({ pending: this.queue.length });
      }
    } finally {
      this.running = false;
      if (!this.disposed) this.set({ syncing: false });
    }
  }

  private applyOutcome(direction: Direction, outcome: MoveOutcome): void {
    const seq = ++this.seq;
    const lastMove: LastMove = { seq, direction, changed: outcome.changed, scoreDelta: outcome.scoreDelta, events: outcome.events };
    if (!outcome.changed) {
      this.set({ lastMove, state: outcome.state, ...(outcome.undoAvailable !== undefined ? { undoAvailable: outcome.undoAvailable } : {}) });
      return;
    }
    const tiles = advanceTiles(this.snap.tiles, outcome.events, outcome.state.board, this.ids);
    const reached = outcome.events.some((e) => e.type === "milestone" && e.exponent === CELEBRATION_EXPONENT);
    const celebrate = this.snap.celebrate || (reached && !this.snap.state.celebrated2048);
    this.set({
      state: outcome.state,
      tiles,
      lastMove,
      celebrate,
      ...(outcome.undoAvailable !== undefined ? { undoAvailable: outcome.undoAvailable } : {}),
    });
  }
}
