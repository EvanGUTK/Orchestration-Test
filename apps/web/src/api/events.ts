import { PROTOCOL_VERSION, WS_PATH } from "@g2048/contracts";
import type { WsClientMessage, WsEnvelope } from "@g2048/contracts";

export type ResourceKind = "game" | "match" | "bot-run";
type Handler = (envelope: WsEnvelope) => void;

/** Server push channel (CONTRACT-001 WebSocket). */
export interface EventStream {
  subscribe(resource: ResourceKind, resourceId: string, handler: Handler, lastSequence?: number): () => void;
}

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type SocketFactory = (url: string) => SocketLike;

export function defaultEventsUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${WS_PATH}`;
}

/**
 * Same-origin WebSocket (the session cookie authenticates it). Subscriptions survive reconnects:
 * after a drop the client reconnects with backoff and resubscribes with the last sequence it saw, and
 * duplicate or out-of-order envelopes (sequence <= last seen) are ignored so state never regresses.
 */
export class WebSocketEventStream implements EventStream {
  private socket: SocketLike | null = null;
  private readonly subs = new Map<string, { resource: ResourceKind; handlers: Set<Handler>; last: number }>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string = defaultEventsUrl(),
    private readonly factory: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike,
  ) {}

  subscribe(resource: ResourceKind, resourceId: string, handler: Handler, lastSequence = 0): () => void {
    let sub = this.subs.get(resourceId);
    if (!sub) {
      sub = { resource, handlers: new Set(), last: lastSequence };
      this.subs.set(resourceId, sub);
      this.send({ type: "subscribe", resource, resourceId, lastSequence });
    }
    sub.handlers.add(handler);
    this.connect();
    return () => {
      const s = this.subs.get(resourceId);
      if (!s) return;
      s.handlers.delete(handler);
      if (s.handlers.size === 0) {
        this.subs.delete(resourceId);
        this.send({ type: "unsubscribe", resourceId });
        if (this.subs.size === 0) this.close();
      }
    };
  }

  private send(message: WsClientMessage) {
    if (this.socket && this.socket.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private connect() {
    if (this.socket || this.timer) return;
    const socket = this.factory(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      for (const [resourceId, s] of this.subs) {
        this.send({ type: "subscribe", resource: s.resource, resourceId, lastSequence: s.last });
      }
    };
    socket.onmessage = (event) => {
      let envelope: WsEnvelope;
      try {
        envelope = JSON.parse(String(event.data)) as WsEnvelope;
      } catch {
        return;
      }
      if (envelope?.protocolVersion !== PROTOCOL_VERSION || typeof envelope.sequence !== "number") return;
      const sub = this.subs.get(envelope.resourceId);
      if (!sub || envelope.sequence <= sub.last) return;
      sub.last = envelope.sequence;
      for (const h of sub.handlers) h(envelope);
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.subs.size === 0) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.connect();
      }, delay);
    };
    socket.onerror = () => socket.close();
  }

  private close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    s?.close();
  }
}
