export type MoveQueueOptions<T> = {
  /** Max moves waiting (not counting the one in flight). Further input is refused visibly, never silently. */
  capacity?: number;
  onOverflow?: (item: T) => void;
  /** Called when `run` rejects. The remaining queued moves are cleared (they targeted an unknown state). */
  onError?: (error: unknown, cleared: number) => void;
};

export const DEFAULT_QUEUE_CAPACITY = 32;

/**
 * Strict FIFO move buffer (UI-04). Exactly one move is in flight at a time; each queued move is applied
 * to the state produced by the previous one, so rapid input can neither reorder, drop, nor double-apply
 * moves. Animation never gates the queue: the authoritative state advances as soon as `run` resolves.
 */
export class MoveQueue<T> {
  private readonly items: T[] = [];
  private inFlight = false;
  private paused = false;
  private readonly capacity: number;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly run: (item: T) => Promise<void>,
    private readonly options: MoveQueueOptions<T> = {},
  ) {
    this.capacity = options.capacity ?? DEFAULT_QUEUE_CAPACITY;
  }

  /** Number of moves waiting, excluding the one in flight. */
  get pending(): number {
    return this.items.length;
  }

  get busy(): boolean {
    return this.inFlight || this.items.length > 0;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  enqueue(item: T): boolean {
    if (this.items.length >= this.capacity) {
      this.options.onOverflow?.(item);
      return false;
    }
    this.items.push(item);
    void this.pump();
    return true;
  }

  /** Stops starting new moves (the in-flight one completes). Used while a modal dialog is open. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.pump();
  }

  /**
   * Puts an item back at the FRONT and pauses (call from inside `run`). Used when the authority could
   * not be reached: the move and everything queued behind it wait, in order, for an explicit resume.
   */
  requeueFront(item: T): void {
    this.items.unshift(item);
    this.paused = true;
  }

  /** Drops queued (not in-flight) moves, e.g. after game over or a new game. Returns how many. */
  clear(): number {
    const n = this.items.length;
    this.items.length = 0;
    this.settleIdle();
    return n;
  }

  /** Resolves when nothing is queued or in flight (or the queue is paused with nothing in flight). */
  idle(): Promise<void> {
    if (!this.inFlight && (this.items.length === 0 || this.paused)) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private settleIdle() {
    if (this.inFlight || (this.items.length > 0 && !this.paused)) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private async pump(): Promise<void> {
    if (this.inFlight) return;
    while (!this.paused && this.items.length > 0) {
      const item = this.items.shift() as T;
      this.inFlight = true;
      try {
        await this.run(item);
      } catch (error) {
        const cleared = this.items.length;
        this.items.length = 0;
        this.options.onError?.(error, cleared);
      } finally {
        this.inFlight = false;
      }
    }
    this.settleIdle();
  }
}
