import type { Direction, DomainEvent } from "@g2048/contracts";
import type { Announcer } from "../a11y/announcer.js";
import { describeApiError, isApiError } from "../api/client.js";
import { formatScore, tileDisplay } from "../lib/format.js";
import type { SoundPlayer } from "../lib/sound.js";
import type { GameAdapter, GameSession, StartRequest } from "./adapter.js";
import { MoveQueue } from "./move-queue.js";

export type LastMove = {
  /** Increments per accepted move; used as the animation key so animations never replay stale events. */
  readonly seq: number;
  readonly direction: Direction;
  readonly events: readonly DomainEvent[];
};

export type GameSnapshot = {
  readonly session: GameSession | null;
  readonly lastMove: LastMove | null;
  /** One-time 2048 celebration dialog is open; the move queue is paused meanwhile. */
  readonly celebrating: boolean;
  /** Short visible status line (no-op move, refused input, errors). */
  readonly notice: string | null;
  readonly queued: number;
  /** Error code of the last failure, for specific recovery actions (e.g. UNAUTHENTICATED -> sign in). */
  readonly errorCode: string | null;
  /**
   * The authority could not be reached: the failed move and everything queued behind it are kept, in
   * order, until the player retries or discards them.
   */
  readonly stalled: { readonly message: string; readonly waiting: number } | null;
};

type Command =
  | { readonly type: "move"; readonly direction: Direction }
  | { readonly type: "undo" }
  | { readonly type: "forfeit" };

const EMPTY: Omit<GameSnapshot, "session"> = {
  lastMove: null,
  celebrating: false,
  notice: null,
  queued: 0,
  errorCode: null,
  stalled: null,
};

export type ControllerDeps = { announcer: Announcer; sound: SoundPlayer };

const DIRECTION_WORD: Record<Direction, string> = { up: "up", right: "right", down: "down", left: "left" };

/**
 * Owns one GameAdapter, the strict FIFO command queue, and the presentation side effects of each
 * accepted move (announcements, sounds, celebration). React subscribes via useSyncExternalStore.
 */
export class GameController {
  private snapshot: GameSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly queue: MoveQueue<Command>;
  private seq = 0;

  constructor(
    readonly adapter: GameAdapter,
    private readonly deps: ControllerDeps,
  ) {
    this.snapshot = { session: adapter.current(), ...EMPTY };
    this.queue = new MoveQueue<Command>((cmd) => this.execute(cmd), {
      onOverflow: () => this.set({ notice: "Input buffer full — waiting for queued moves to finish." }),
      onError: (_error, cleared) => {
        const message =
          cleared > 0 ? `Move failed; ${cleared} queued move(s) were cancelled.` : "Move failed. Try again.";
        this.set({ notice: message, queued: 0 });
        this.deps.announcer.announce(message, "important");
      },
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): GameSnapshot => this.snapshot;

  /**
   * Queues a move. Held-key auto-repeat only queues when nothing is pending, so holding a key cannot
   * build an invisible backlog; every deliberate key press / swipe / button press is queued in order.
   */
  move(direction: Direction, options: { repeat?: boolean } = {}): boolean {
    const session = this.snapshot.session;
    if (!session || session.state.status !== "active" || this.snapshot.celebrating) return false;
    if (options.repeat && (this.queue.busy || this.snapshot.stalled)) return false;
    const accepted = this.queue.enqueue({ type: "move", direction });
    if (accepted) this.set({ queued: this.queue.pending });
    return accepted;
  }

  undo(): boolean {
    const session = this.snapshot.session;
    if (!session || !session.rules.undo) return false;
    const accepted = this.queue.enqueue({ type: "undo" });
    if (accepted) this.set({ queued: this.queue.pending });
    return accepted;
  }

  /** Ends the current game after queued moves (casual: abandon; server: forfeit exactly once). */
  forfeit(): boolean {
    const session = this.snapshot.session;
    if (!session || session.state.status !== "active") return false;
    return this.queue.enqueue({ type: "forfeit" });
  }

  async start(request: StartRequest): Promise<GameSession> {
    await this.settle();
    const session = await this.adapter.start(request);
    this.queue.resume();
    this.set({ session, ...EMPTY });
    const size = `${session.rules.size} by ${session.rules.size}`;
    this.deps.announcer.announce(`New ${request.mode} game, ${size}. Score 0.`, "important");
    return session;
  }

  /** Loads a session obtained from the adapter (e.g. resuming a saved server game). */
  async load(open: (adapter: GameAdapter) => Promise<GameSession>): Promise<GameSession> {
    await this.settle();
    const session = await open(this.adapter);
    this.queue.resume();
    this.set({ session, ...EMPTY });
    return session;
  }

  async discard(): Promise<void> {
    await this.settle();
    await this.adapter.discard();
    this.queue.resume();
    this.set({ session: null, ...EMPTY });
  }

  /** Retries a stalled queue: the unresolved move is re-sent with its original commandId first. */
  retryStalled(): void {
    if (!this.snapshot.stalled) return;
    this.set({ stalled: null, notice: null, errorCode: null });
    this.queue.resume();
  }

  /**
   * Drops the waiting moves and re-reads the authoritative state (which already reflects the unresolved
   * move if the server applied it). Nothing is applied twice.
   */
  async discardStalled(): Promise<void> {
    const dropped = this.queue.clear();
    try {
      const session = await this.adapter.reload();
      this.set({
        ...EMPTY,
        session,
        notice: `${dropped} waiting move(s) discarded. Showing the saved game.`,
      });
      this.queue.resume();
    } catch {
      this.set({ notice: "Still can't reach the server. Try again shortly.", queued: 0 });
    }
  }

  /** Re-reads the authoritative game state (after a conflict or error). */
  async reload(): Promise<void> {
    await this.settle();
    try {
      const session = await this.adapter.reload();
      this.queue.resume();
      this.set({ session, ...EMPTY });
    } catch {
      this.set({ notice: "Couldn't reload the game. Check the connection and try again." });
    }
  }

  private async settle() {
    this.queue.clear();
    await this.queue.idle();
  }

  /** Closes the one-time 2048 dialog and resumes queued input. */
  keepPlaying(): void {
    this.set({ celebrating: false });
    this.queue.resume();
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  /** Spoken summary of the board for the "Read board" control. */
  describeBoard(): string {
    const session = this.snapshot.session;
    if (!session) return "No game in progress.";
    const { size, cells } = session.state.board;
    const rows: string[] = [];
    for (let r = 0; r < size; r++) {
      const row = cells
        .slice(r * size, r * size + size)
        .map((c) => (c === null ? "empty" : tileDisplay(c, "auto").ariaLabel));
      rows.push(`Row ${r + 1}: ${row.join(", ")}`);
    }
    return rows.join(". ");
  }

  private set(patch: Partial<GameSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private async execute(cmd: Command): Promise<void> {
    const { announcer, sound } = this.deps;
    if (cmd.type === "undo" || cmd.type === "forfeit") {
      let session: GameSession | null;
      try {
        session = cmd.type === "undo" ? await this.adapter.undo() : await this.adapter.forfeit();
      } catch (error) {
        const cleared = this.queue.clear();
        const what = cmd.type === "undo" ? "Undo" : "Ending the game";
        const message = `${what} failed: ${describeApiError(error)}`;
        this.set({
          notice: cleared > 0 ? `${message} ${cleared} queued move(s) cancelled.` : message,
          errorCode: isApiError(error) ? error.code : "INTERNAL_ERROR",
          session: this.adapter.current(),
          queued: 0,
        });
        announcer.announce(message, "important");
        return;
      }
      if (cmd.type === "forfeit") {
        this.queue.clear();
        this.set({ session, lastMove: null, notice: "Game ended.", queued: 0, errorCode: null });
        announcer.announce("Game ended.", "important");
      } else if (session) {
        this.set({ session, lastMove: null, notice: null, queued: this.queue.pending, errorCode: null });
        announcer.announce(`Move undone. Score ${formatScore(session.state.score).spoken}.`);
      } else {
        this.set({ notice: "Nothing to undo.", queued: this.queue.pending });
      }
      return;
    }

    const outcome = await this.adapter.move(cmd.direction);
    if (!outcome.ok && outcome.retryable) {
      // Keep the move (its commandId stays inside the adapter) and everything behind it, in order.
      this.queue.requeueFront(cmd);
      const waiting = this.queue.pending;
      this.set({
        stalled: { message: outcome.message, waiting },
        errorCode: outcome.code,
        notice: null,
        queued: waiting,
      });
      announcer.announce(`Connection problem. ${waiting} move(s) waiting.`, "important");
      return;
    }
    if (!outcome.ok) {
      const cleared = this.queue.clear();
      const message =
        outcome.code === "RESOURCE_LIMIT"
          ? "That move would exceed this build's tile limit. Your game is unchanged."
          : outcome.code === "GAME_NOT_ACTIVE"
            ? "This game has ended."
            : `Move not applied: ${outcome.message}`;
      this.set({
        notice: cleared > 0 ? `${message} ${cleared} queued move(s) cancelled.` : message,
        queued: 0,
        errorCode: outcome.code,
        session: this.adapter.current() ?? this.snapshot.session,
      });
      announcer.announce(message, "important");
      return;
    }
    if (!outcome.changed) {
      // Valid no-op (NO_CHANGE): nothing spawned and no move counted.
      this.set({
        errorCode: null,
        notice: `No tiles can move ${DIRECTION_WORD[cmd.direction]}.`,
        queued: this.queue.pending,
      });
      announcer.announce(`Can't move ${DIRECTION_WORD[cmd.direction]}.`);
      return;
    }

    this.seq += 1;
    const session = outcome.session;
    let celebrating = this.snapshot.celebrating;
    let merged = false;
    for (const event of outcome.events) {
      if (event.type === "tile.merged") merged = true;
      if (event.type === "milestone.reached") {
        announcer.announce(`New highest tile: ${tileDisplay(event.exponent, "auto").ariaLabel}`, "important");
        if (event.first2048) {
          celebrating = true;
          this.queue.pause();
          sound.play("milestone");
        }
      }
    }
    if (merged) sound.play("merge");

    const ended = session.state.status !== "active";
    if (ended) {
      this.queue.clear();
      sound.play("over");
      announcer.announce(`Game over. Final score ${formatScore(session.state.score).spoken}.`, "important");
    } else {
      announcer.announce(`Score ${formatScore(session.state.score).spoken}.`);
    }
    this.set({
      session,
      lastMove: { seq: this.seq, direction: cmd.direction, events: outcome.events },
      celebrating,
      notice: null,
      errorCode: null,
      queued: this.queue.pending,
    });
  }
}
