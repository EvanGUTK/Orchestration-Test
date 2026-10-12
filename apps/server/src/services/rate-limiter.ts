/**
 * In-memory sliding-window attempt counter (local, single process). A key is blocked once it has
 * `limit` recorded attempts within `windowMs`. Memory is bounded: expired timestamps are pruned on
 * access and the number of tracked keys is capped (oldest evicted).
 *
 * `reserve` checks AND records in one synchronous step, so concurrent requests cannot all pass the
 * check before any of them records a failure (SEC-FIX-001 M1). Callers `release` or `reset` after a
 * success when the attempt should not count.
 */
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export class FailureRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  readonly #now: () => number;
  readonly #attempts = new Map<string, number[]>();

  constructor(options: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  #recent(key: string, now: number): number[] {
    const kept = (this.#attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length === 0) this.#attempts.delete(key);
    else this.#attempts.set(key, kept);
    return kept;
  }

  #decide(recent: number[], now: number): RateLimitDecision {
    if (recent.length < this.limit) return { allowed: true };
    const oldest = recent[recent.length - this.limit] ?? now;
    return { allowed: false, retryAfterMs: Math.max(1, this.windowMs - (now - oldest)) };
  }

  check(key: string): RateLimitDecision {
    const now = this.#now();
    return this.#decide(this.#recent(key, now), now);
  }

  /** Atomically: if allowed, record one attempt now. */
  reserve(key: string): RateLimitDecision {
    const now = this.#now();
    const recent = this.#recent(key, now);
    const decision = this.#decide(recent, now);
    if (decision.allowed) this.#record(key, recent, now);
    return decision;
  }

  /** Records an attempt unconditionally. */
  fail(key: string): void {
    const now = this.#now();
    this.#record(key, this.#recent(key, now), now);
  }

  /** Removes the most recent recorded attempt (an attempt that succeeded and should not count). */
  release(key: string): void {
    const list = this.#attempts.get(key);
    if (!list) return;
    list.pop();
    if (list.length === 0) this.#attempts.delete(key);
  }

  reset(key: string): void {
    this.#attempts.delete(key);
  }

  #record(key: string, recent: number[], now: number): void {
    recent.push(now);
    this.#attempts.delete(key);
    this.#attempts.set(key, recent); // re-insert: Map order doubles as LRU order
    while (this.#attempts.size > this.maxKeys) {
      const oldestKey = this.#attempts.keys().next().value;
      if (oldestKey === undefined) break;
      this.#attempts.delete(oldestKey);
    }
  }
}
