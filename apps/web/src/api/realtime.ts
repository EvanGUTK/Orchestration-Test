import { useEffect, useRef, useState } from "react";
import { WS_PROTOCOL_VERSION } from "@2048/contracts";
import type { WsClientMessage, WsEnvelope } from "@2048/contracts";

export type RealtimeStatus = "connecting" | "open" | "reconnecting" | "closed";

export type RealtimeOptions = {
  url?: string;
  /** Called on every (re)connect before envelopes flow, so callers can fetch an authoritative snapshot. */
  onResync(): void;
  onEnvelope(envelope: WsEnvelope): void;
  onStatus?(status: RealtimeStatus): void;
  webSocketFactory?: (url: string) => WebSocket;
};

export function defaultEventsUrl(loc: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/api/v1/events`;
}

/**
 * Single-socket client with reconnect + snapshot resync. Duplicate or out-of-order envelopes
 * (sequence <= last seen for that resource) are dropped so UI state never regresses.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly last = new Map<string, number>();
  private readonly options: RealtimeOptions;

  constructor(options: RealtimeOptions) {
    this.options = options;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  subscribe(resourceId: string, lastSequence: number): void {
    this.last.set(resourceId, Math.max(this.last.get(resourceId) ?? 0, lastSequence));
    this.send({ type: "subscribe", resourceId, lastSequence: this.last.get(resourceId) ?? 0 });
  }

  unsubscribe(resourceId: string): void {
    this.last.delete(resourceId);
    this.send({ type: "unsubscribe", resourceId });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
    this.options.onStatus?.("closed");
  }

  private send(message: WsClientMessage): void {
    if (this.socket && this.socket.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    this.options.onStatus?.(this.attempt === 0 ? "connecting" : "reconnecting");
    const url = this.options.url ?? defaultEventsUrl();
    let socket: WebSocket;
    try {
      socket = this.options.webSocketFactory ? this.options.webSocketFactory(url) : new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.options.onStatus?.("open");
      this.options.onResync();
      for (const [resourceId, lastSequence] of this.last) this.send({ type: "subscribe", resourceId, lastSequence });
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let envelope: WsEnvelope;
      try {
        envelope = JSON.parse(event.data) as WsEnvelope;
      } catch {
        return;
      }
      if (envelope.protocolVersion !== WS_PROTOCOL_VERSION) return;
      if (envelope.type === "server.recovering") {
        this.options.onStatus?.("reconnecting");
        this.options.onResync();
        return;
      }
      const seen = this.last.get(envelope.resourceId);
      if (seen !== undefined && envelope.sequence <= seen) return;
      this.last.set(envelope.resourceId, envelope.sequence);
      this.options.onEnvelope(envelope);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (!this.closed) this.scheduleReconnect();
    };
    socket.onerror = () => {
      /* onclose follows and drives the reconnect */
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.attempt++;
    this.options.onStatus?.("reconnecting");
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempt, 5));
    this.timer = setTimeout(() => this.connect(), delay);
  }
}

/** Subscribe a component to one resource's live envelopes; `onResync` should refetch the snapshot. */
export function useRealtime(
  resourceIds: readonly string[],
  onEnvelope: (envelope: WsEnvelope) => void,
  onResync: () => void,
  enabled = true,
): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>("closed");
  const envelopeRef = useRef(onEnvelope);
  const resyncRef = useRef(onResync);
  envelopeRef.current = onEnvelope;
  resyncRef.current = onResync;
  const key = resourceIds.join("|");

  useEffect(() => {
    if (!enabled || key === "" || typeof WebSocket === "undefined") return;
    const client = new RealtimeClient({
      onEnvelope: (e) => envelopeRef.current(e),
      onResync: () => resyncRef.current(),
      onStatus: setStatus,
    });
    for (const id of key.split("|")) client.subscribe(id, 0);
    client.start();
    return () => client.close();
  }, [key, enabled]);

  return status;
}
