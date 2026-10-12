export type Priority = "normal" | "important";

export type AnnouncerOptions = {
  /** Minimum time between two live-region updates. */
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export const DEFAULT_ANNOUNCE_INTERVAL_MS = 1200;

/**
 * Throttled screen-reader announcer for an aria-live="polite" region.
 * - At most one update per `intervalMs`, however fast moves/animations happen.
 * - "normal" messages (score changes) coalesce: only the latest pending one is spoken.
 * - "important" messages (milestones, game over, errors) are never coalesced away; they are spoken
 *   together, ahead of the latest normal message, at the next allowed slot.
 */
export class Announcer {
  private readonly listeners = new Set<(message: string) => void>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private important: string[] = [];
  private normal: string | null = null;

  constructor(options: AnnouncerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_ANNOUNCE_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  subscribe(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announce(message: string, priority: Priority = "normal"): void {
    if (!message) return;
    if (priority === "important") {
      if (!this.important.includes(message)) this.important.push(message);
    } else {
      this.normal = message;
    }
    const wait = this.lastEmit + this.intervalMs - this.now();
    if (wait <= 0 && this.timer === null) {
      this.flush();
    } else if (this.timer === null) {
      this.timer = this.setTimer(
        () => {
          this.timer = null;
          this.flush();
        },
        Math.max(0, wait),
      );
    }
  }

  /** Drops anything pending (e.g. when leaving the game screen). */
  cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.important = [];
    this.normal = null;
  }

  private flush(): void {
    const parts = [...this.important];
    if (this.normal) parts.push(this.normal);
    this.important = [];
    this.normal = null;
    if (parts.length === 0) return;
    this.lastEmit = this.now();
    const message = parts.join(". ");
    for (const listener of this.listeners) listener(message);
  }
}
