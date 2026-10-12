import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { DomainError, WS_PROTOCOL_VERSION, type WsClientMessage, type WsEnvelope } from "@2048/contracts";
import { principalsOf, type AppServices } from "../app.ts";
import { forbidden, unauthenticated } from "../errors.ts";
import type { HubConnection } from "../services/hub.ts";
import { ownerOf } from "../services/games.ts";

const HEARTBEAT_MS = 20_000;
/** Hard cap on simultaneous sockets for this single-machine server. */
export const MAX_WS_CONNECTIONS = 256;
const MAX_MESSAGES_PER_WINDOW = 200;
const WINDOW_MS = 10_000;
let nextId = 1;

function parseClientMessage(raw: string): WsClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const t = (m as { type?: unknown }).type;
  if (t === "pong") return { type: "pong" };
  const resourceId = (m as { resourceId?: unknown }).resourceId;
  if (typeof resourceId !== "string" || resourceId.length === 0 || resourceId.length > 64) return null;
  if (t === "unsubscribe") return { type: "unsubscribe", resourceId };
  if (t === "subscribe") {
    const last = (m as { lastSequence?: unknown }).lastSequence;
    if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0) return null;
    return { type: "subscribe", resourceId, lastSequence: last };
  }
  return null;
}

export function registerEventRoutes(app: FastifyInstance, s: AppServices): void {
  app.get(
    "/events",
    {
      websocket: true,
      // Runs before the HTTP upgrade completes: bad Origin or no session never gets a socket.
      preValidation: async (req) => {
        const origin = req.headers.origin;
        if (typeof origin !== "string" || !s.isTrustedOrigin(origin)) throw forbidden("Cross-origin WebSocket rejected");
        const { user, guest } = principalsOf(s, req);
        if (!user && !guest) throw unauthenticated();
        if (s.hub.size >= MAX_WS_CONNECTIONS) throw new DomainError("RESOURCE_LIMIT", "Too many open event connections");
      },
    },
    (socket: WebSocket, req) => {
      const { user, guest } = principalsOf(s, req);
      const principal = (user ?? guest)!;
      const owner = ownerOf(principal);
      let alive = true;
      let windowStart = Date.now();
      let messages = 0;
      const conn: HubConnection = {
        id: nextId++,
        accountId: principal.userId,
        subscriptions: new Set(),
        buffered: () => socket.bufferedAmount,
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
      };
      s.hub.add(conn);
      if (s.hub.recovering) {
        const env: WsEnvelope = { protocolVersion: WS_PROTOCOL_VERSION, type: "server.recovering", resourceId: "server", sequence: Date.now(), payload: { reason: "restoring bot runs" } };
        socket.send(JSON.stringify(env));
      }

      const heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, HEARTBEAT_MS);
      heartbeat.unref();
      socket.on("pong", () => { alive = true; });

      socket.on("message", (data, isBinary) => {
        const now = Date.now();
        if (now - windowStart > WINDOW_MS) { windowStart = now; messages = 0; }
        if (++messages > MAX_MESSAGES_PER_WINDOW) return socket.close(1008, "rate limit");
        if (isBinary) return socket.close(1003, "text frames only");
        const msg = parseClientMessage(data.toString("utf8"));
        if (!msg) return socket.close(1003, "malformed message");
        alive = true;
        if (msg.type === "pong") return;
        if (msg.type === "unsubscribe") return s.hub.unsubscribe(conn, msg.resourceId);
        // subscribe: authorization is checked per resource; unauthorized ids are ignored without a signal
        const allowed =
          msg.resourceId === principal.userId ||
          s.games.canRead(owner, msg.resourceId) ||
          (principal.kind === "user" && s.matches.canRead(principal.userId, msg.resourceId)) ||
          s.bots.canRead(principal.userId, msg.resourceId);
        if (!allowed) return;
        if (!s.hub.subscribe(conn, msg.resourceId)) return socket.close(1008, "too many subscriptions");
        // Catch-up so a reconnecting client never has a gap: send the authoritative current snapshot if it is newer.
        const snap = s.snapshotFor(owner, principal.userId, msg.resourceId, msg.lastSequence);
        if (snap) s.hub.sendTo(conn, snap);
      });

      socket.on("close", () => {
        clearInterval(heartbeat);
        s.hub.remove(conn);
      });
      socket.on("error", () => {
        clearInterval(heartbeat);
        s.hub.remove(conn);
      });
    },
  );
}
