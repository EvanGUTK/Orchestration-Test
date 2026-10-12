import type { WsEnvelope } from "@2048/contracts";
import type { Publication } from "./outbox.ts";

export type HubConnection = {
  readonly id: number;
  readonly accountId: string;
  readonly subscriptions: Set<string>;
  /** Bytes queued in the socket but not yet flushed to the peer. */
  buffered(): number;
  send(text: string): void;
  close(code: number, reason: string): void;
};

export type HubOptions = {
  /** A consumer whose pending output exceeds this is disconnected explicitly (code 1013). */
  maxBufferedBytes?: number;
  maxSubscriptionsPerConnection?: number;
};

/**
 * In-process publish/subscribe for committed events. Publishing happens only after the database commit.
 * Delivery is at-most-once per connection and ordered per resource; clients repair gaps by refetching a
 * snapshot (sequence numbers let them discard duplicates and stale envelopes).
 */
export class EventHub {
  readonly #conns = new Set<HubConnection>();
  readonly #byResource = new Map<string, Set<HubConnection>>();
  readonly #byAccount = new Map<string, Set<HubConnection>>();
  readonly maxBufferedBytes: number;
  readonly maxSubscriptions: number;
  recovering = false;
  slowConsumersDropped = 0;

  constructor(options: HubOptions = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
    this.maxSubscriptions = options.maxSubscriptionsPerConnection ?? 100;
  }

  get size(): number {
    return this.#conns.size;
  }

  add(c: HubConnection): void {
    this.#conns.add(c);
    let set = this.#byAccount.get(c.accountId);
    if (!set) this.#byAccount.set(c.accountId, (set = new Set()));
    set.add(c);
  }

  remove(c: HubConnection): void {
    this.#conns.delete(c);
    for (const r of c.subscriptions) this.#unindex(r, c);
    c.subscriptions.clear();
    const set = this.#byAccount.get(c.accountId);
    set?.delete(c);
    if (set && set.size === 0) this.#byAccount.delete(c.accountId);
  }

  subscribe(c: HubConnection, resourceId: string): boolean {
    if (c.subscriptions.has(resourceId)) return true;
    if (c.subscriptions.size >= this.maxSubscriptions) return false;
    c.subscriptions.add(resourceId);
    let set = this.#byResource.get(resourceId);
    if (!set) this.#byResource.set(resourceId, (set = new Set()));
    set.add(c);
    return true;
  }

  unsubscribe(c: HubConnection, resourceId: string): void {
    c.subscriptions.delete(resourceId);
    this.#unindex(resourceId, c);
  }

  #unindex(resourceId: string, c: HubConnection): void {
    const set = this.#byResource.get(resourceId);
    set?.delete(c);
    if (set && set.size === 0) this.#byResource.delete(resourceId);
  }

  /** Send one envelope to one connection, enforcing the backpressure bound. */
  sendTo(c: HubConnection, envelope: WsEnvelope): boolean {
    if (c.buffered() > this.maxBufferedBytes) {
      this.slowConsumersDropped++;
      c.close(1013, "slow consumer");
      this.remove(c);
      return false;
    }
    c.send(JSON.stringify(envelope));
    return true;
  }

  publish(items: readonly Publication[]): void {
    for (const { envelope, accounts } of items) {
      const targets = new Set<HubConnection>(this.#byResource.get(envelope.resourceId));
      for (const a of accounts ?? []) for (const c of this.#byAccount.get(a) ?? []) targets.add(c);
      if (targets.size === 0) continue;
      const text = JSON.stringify(envelope);
      for (const c of targets) {
        if (c.buffered() > this.maxBufferedBytes) {
          this.slowConsumersDropped++;
          c.close(1013, "slow consumer");
          this.remove(c);
          continue;
        }
        c.send(text);
      }
    }
  }

  closeAll(code: number, reason: string): void {
    for (const c of [...this.#conns]) c.close(code, reason);
  }
}
