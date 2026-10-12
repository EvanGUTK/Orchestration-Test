/**
 * In-memory sliding-window failure counter (local, single process). A key is blocked once it has
 * `limit` recorded failures within `windowMs`. Memory is bounded: expired timestamps are pruned on
 * access and the number of tracked keys is capped (oldest evicted).
 */
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export class FailureRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  readonly #now: () => number;
  readonly #failures = new Map<string, number[]>();

  constructor(options: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  #recent(key: string, now: number): number[] {
    const kept = (this.#failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, kept);
    return kept;
  }

  check(key: string): RateLimitDecision {
    const now = this.#now();
    const recent = this.#recent(key, now);
    if (recent.length < this.limit) return { allowed: true };
    const oldest = recent[recent.length - this.limit] ?? now;
    return { allowed: false, retryAfterMs: Math.max(1, this.windowMs - (now - oldest)) };
  }

  fail(key: string): void {
    const now = this.#now();
    const recent = this.#recent(key, now);
    recent.push(now);
    this.#failures.delete(key);
    this.#failures.set(key, recent); // re-insert: Map order doubles as LRU order
    while (this.#failures.size > this.maxKeys) {
      const oldestKey = this.#failures.keys().next().value;
      if (oldestKey === undefined) break;
      this.#failures.delete(oldestKey);
    }
  }

  reset(key: string): void {
    this.#failures.delete(key);
  }
}
