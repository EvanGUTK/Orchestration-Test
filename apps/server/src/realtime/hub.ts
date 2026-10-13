import {
  LIMITS,
  PROTOCOL_VERSION,
  WsClientMessage,
  type WsEnvelope,
  type WsEventType,
} from "@g2048/contracts";

/** The slice of a `ws` WebSocket the hub uses (`ws` ships no type declarations). */
export type HubSocket = {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "message", listener: (data: { toString(): string }, isBinary: boolean) => void): unknown;
  on(event: "pong" | "close" | "error", listener: () => void): unknown;
};

export type RealtimeResource = "game" | "match" | "bot-run";

/** An event to deliver to subscribers of one resource. Publish only AFTER the DB commit. */
export type Publication = {
  /** null = every resource kind with this id (used for `server.recovering`). */
  resource: RealtimeResource | null;
  resourceId: string;
  type: WsEventType;
  /** Per-resource sequence (game revision / match sequence / bot-run move index). */
  sequence: number;
  payload: unknown;
};

/** Close codes (application range 4000-4999). */
export const WS_CLOSE = {
  malformed: 4400,
  forbidden: 4403,
  tooManySubscriptions: 4429,
  slowConsumer: 4008,
  heartbeatTimeout: 4001,
  serverShutdown: 1001,
} as const;

export type CatchUp = { kind: "events"; events: Publication[] } | { kind: "resync" };

/** Per-connection authorization + catch-up, bound to the identity resolved before the upgrade. */
export type ConnectionContext = {
  authorize(resource: RealtimeResource, resourceId: string): boolean;
  catchUp(resource: RealtimeResource, resourceId: string, lastSequence: number): CatchUp;
};

export type RealtimeHubOptions = {
  /** Max queued outbound messages per socket before it is closed as a slow consumer. */
  outboundQueueMax?: number;
  /** Bytes buffered in the socket above which we stop writing and queue instead. */
  highWaterBytes?: number;
  maxSubscriptions?: number;
  heartbeatMs?: number;
  /** Most catch-up events sent on subscribe; more missing events => server.recovering (resync). */
  catchUpMax?: number;
};

type Subscription = { resource: RealtimeResource; lastSent: number };

class Connection {
  readonly subscriptions = new Map<string, Subscription>();
  readonly queue: string[] = [];
  alive = true;
  closed = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly socket: HubSocket,
    readonly context: ConnectionContext,
    private readonly hub: RealtimeHub,
  ) {}

  enqueue(envelope: WsEnvelope): void {
    if (this.closed) return;
    this.queue.push(JSON.stringify(envelope));
    if (this.queue.length > this.hub.outboundQueueMax) {
      this.close(WS_CLOSE.slowConsumer, "slow consumer", true);
      return;
    }
    this.flush();
  }

  flush(): void {
    if (this.closed) return;
    while (this.queue.length > 0 && this.socket.bufferedAmount < this.hub.highWaterBytes) {
      this.socket.send(this.queue.shift() as string);
    }
    if (this.queue.length > 0 && this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, 10);
      this.flushTimer.unref();
    }
  }

  close(code: number, reason: string, terminateAfter = false): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    try {
      this.socket.close(code, reason);
    } catch {
      // already closing
    }
    if (terminateAfter) {
      // A slow consumer may never read the close frame; drop the TCP connection shortly after.
      setTimeout(() => this.socket.terminate(), 1000).unref();
    }
    this.hub.detach(this);
  }
}

/**
 * WebSocket fan-out (ARCHITECTURE: "Commit before sending a socket event").
 *
 * - Subscriptions are checked with the connection's authorize() (owned/authorized resources only),
 *   at most `maxSubscriptions` per socket.
 * - Subscribing with `lastSequence` first replays missing events from the database (catchUp);
 *   when too many are missing the client gets `server.recovering` (sequence 0) and must refetch the
 *   authoritative snapshot over HTTP, then resubscribe.
 * - Per socket and resource, events at or below the last delivered sequence are dropped, so the
 *   catch-up/live overlap never produces duplicates and nothing regresses.
 * - Outbound backpressure is bounded: messages queue while the socket buffer is above
 *   `highWaterBytes`; more than `outboundQueueMax` queued messages closes the socket (4008).
 * - Heartbeat: ping every `heartbeatMs`; a socket that did not answer since the last ping is
 *   terminated. Malformed client messages close the socket (4400); the server never throws.
 */
export class RealtimeHub {
  readonly outboundQueueMax: number;
  readonly highWaterBytes: number;
  readonly maxSubscriptions: number;
  readonly catchUpMax: number;
  private readonly connections = new Set<Connection>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(options: RealtimeHubOptions = {}) {
    this.outboundQueueMax = options.outboundQueueMax ?? LIMITS.wsOutboundQueueMax;
    this.highWaterBytes = options.highWaterBytes ?? 256 * 1024;
    this.maxSubscriptions = options.maxSubscriptions ?? LIMITS.wsMaxSubscriptions;
    this.catchUpMax = options.catchUpMax ?? 200;
    this.heartbeat = setInterval(() => this.beat(), options.heartbeatMs ?? LIMITS.wsHeartbeatMs);
    this.heartbeat.unref();
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  attach(socket: HubSocket, context: ConnectionContext): void {
    const conn = new Connection(socket, context, this);
    this.connections.add(conn);
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      conn.alive = true;
      try {
        this.onMessage(conn, isBinary ? null : data.toString());
      } catch {
        conn.close(WS_CLOSE.malformed, "bad message");
      }
    });
    socket.on("close", () => this.detach(conn));
    socket.on("error", () => conn.close(WS_CLOSE.malformed, "socket error"));
  }

  detach(conn: Connection): void {
    conn.closed = true;
    this.connections.delete(conn);
  }

  /** Delivers to every subscriber of the resource. Call only after the transaction committed. */
  publish(publication: Publication): void {
    const keys =
      publication.resource === null
        ? (["game", "match", "bot-run"] as const).map((r) => keyOf(r, publication.resourceId))
        : [keyOf(publication.resource, publication.resourceId)];
    for (const conn of this.connections) {
      const key = keys.find((k) => conn.subscriptions.has(k));
      const sub = key === undefined ? undefined : conn.subscriptions.get(key);
      if (!sub) continue;
      if (publication.type !== "server.recovering") {
        if (publication.sequence <= sub.lastSent) continue;
        sub.lastSent = publication.sequence;
      }
      conn.enqueue(envelopeOf(publication));
    }
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const conn of [...this.connections]) conn.close(WS_CLOSE.serverShutdown, "server shutting down");
  }

  private beat(): void {
    for (const conn of [...this.connections]) {
      if (!conn.alive) {
        conn.socket.terminate();
        this.detach(conn);
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        conn.close(WS_CLOSE.heartbeatTimeout, "heartbeat failed");
      }
    }
  }

  private onMessage(conn: Connection, text: string | null): void {
    if (text === null) return conn.close(WS_CLOSE.malformed, "binary messages are not supported");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return conn.close(WS_CLOSE.malformed, "malformed JSON");
    }
    const parsed = WsClientMessage.safeParse(raw);
    if (!parsed.success) return conn.close(WS_CLOSE.malformed, "unknown message");
    const message = parsed.data;
    if (message.type === "ping") return;
    if (message.type === "unsubscribe") {
      for (const key of [...conn.subscriptions.keys()]) {
        if (key.endsWith(`:${message.resourceId}`)) conn.subscriptions.delete(key);
      }
      return;
    }
    const key = keyOf(message.resource, message.resourceId);
    if (!conn.subscriptions.has(key) && conn.subscriptions.size >= this.maxSubscriptions) {
      return conn.close(WS_CLOSE.tooManySubscriptions, "too many subscriptions");
    }
    if (!conn.context.authorize(message.resource, message.resourceId)) {
      return conn.close(WS_CLOSE.forbidden, "not authorized for this resource");
    }
    const sub: Subscription = { resource: message.resource, lastSent: message.lastSequence };
    conn.subscriptions.set(key, sub);
    const missing = conn.context.catchUp(message.resource, message.resourceId, message.lastSequence);
    if (missing.kind === "resync" || missing.events.length > this.catchUpMax) {
      conn.enqueue(
        envelopeOf({
          resource: message.resource,
          resourceId: message.resourceId,
          type: "server.recovering",
          sequence: 0,
          payload: { reason: "resync", resource: message.resource },
        }),
      );
      return;
    }
    for (const event of missing.events) {
      if (event.sequence <= sub.lastSent) continue;
      sub.lastSent = event.sequence;
      conn.enqueue(envelopeOf(event));
    }
  }
}

function keyOf(resource: RealtimeResource, resourceId: string): string {
  return `${resource}:${resourceId}`;
}

function envelopeOf(p: Publication): WsEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: p.type,
    resourceId: p.resourceId,
    sequence: p.sequence,
    payload: p.payload,
  };
}
