import { DomainError } from "@2048/contracts";

/**
 * In-memory failure counter with a fixed window per key and a hard key cap (memory stays bounded
 * under a flood of distinct keys). Used for login/password-guess throttling and creation limits.
 */
export class AttemptLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #entries = new Map<string, { count: number; resetAt: number }>();

  constructor(max: number, windowMs: number, maxKeys = 10_000) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
  }

  /** Throws RATE_LIMITED when `key` has already used its allowance. */
  assertAllowed(key: string, now = Date.now()): void {
    const e = this.#entries.get(key);
    if (!e) return;
    if (e.resetAt <= now) {
      this.#entries.delete(key);
      return;
    }
    if (e.count >= this.#max) {
      const retryAfterSec = Math.max(1, Math.ceil((e.resetAt - now) / 1000));
      throw new DomainError("RATE_LIMITED", "Too many attempts; try again later", { retryAfterSec });
    }
  }

  /** Record one attempt (failure or creation). */
  hit(key: string, now = Date.now()): void {
    const e = this.#entries.get(key);
    if (e && e.resetAt > now) {
      e.count++;
      return;
    }
    if (this.#entries.size >= this.#maxKeys) this.#evict(now);
    this.#entries.set(key, { count: 1, resetAt: now + this.#windowMs });
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }

  #evict(now: number): void {
    for (const [k, v] of this.#entries) if (v.resetAt <= now) this.#entries.delete(k);
    while (this.#entries.size >= this.#maxKeys) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
