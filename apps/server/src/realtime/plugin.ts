import type { FastifyPluginAsync } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WS_PATH, type WsEventType } from "@g2048/contracts";
import { gamesRepo } from "@g2048/database";
import { AppError } from "../http/errors.js";
import { checkSameOrigin } from "../security/origin.js";
import type { CommittedEvent } from "../services/event-bus.js";
import { HTTP_READ_MODES } from "../services/game-service.js";
import type { Identity } from "../services/identity.js";
import {
  RealtimeHub,
  type CatchUp,
  type HubSocket,
  type Publication,
  type RealtimeHubOptions,
  type RealtimeResource,
} from "./hub.js";

/**
 * Authorization and catch-up for one resource kind. Feature plugins (matches) register providers.
 * A subscription is allowed only when a provider authorizes it for the identity bound to the socket;
 * catch-up comes from the first provider that answers.
 */
export type RealtimeProvider = {
  authorize(identity: Identity, resourceId: string): boolean;
  catchUp?(resourceId: string, lastSequence: number, limit: number): CatchUp | null;
};

export type Realtime = {
  hub: RealtimeHub;
  provide(resource: RealtimeResource, provider: RealtimeProvider): void;
};

declare module "fastify" {
  interface FastifyInstance {
    realtime: Realtime;
  }
}

export type RealtimePluginOptions = RealtimeHubOptions & {
  /** Max inbound client frame size (bytes). */
  maxPayload?: number;
};

/** Which subscription key a committed event belongs to (EventBus events carry no owner info). */
export function resourceOf(type: WsEventType): RealtimeResource | null {
  switch (type) {
    case "game.updated":
      return "game";
    case "bot.progress":
    case "bot.finished":
      return "bot-run";
    case "server.recovering":
      return null;
    default:
      return "match"; // match.updated, match.seat-ended, match.finished, rating.updated
  }
}

export function publicationOf(event: CommittedEvent): Publication {
  return { resource: resourceOf(event.type), ...event };
}

/**
 * WebSocket endpoint `/api/v1/events` (CONTRACT ws.ts, docs/CONTRACTS.md "WebSocket", ACC-04).
 *
 * Before the upgrade: the root security hook has already enforced a loopback/allowed Host, rejected
 * cross-site Fetch metadata and resolved the session cookies; this route additionally requires
 * `Origin` (when present) to equal `<protocol>://<Host>` and an account or guest session. Refusals
 * are plain HTTP 403/401 responses, so no socket is opened for them.
 *
 * Delivery: the hub subscribes to app.services.events (EventBus), which only emits after COMMIT.
 * EventBus payloads carry no owner information, so every subscription is authorized here:
 *  - game: the caller owns it AND its mode is in HTTP_READ_MODES (duel seat games are watched
 *    through their match);
 *  - match: a seat account (or the creator of a bot-bot match) — registered by the matches plugin;
 *  - bot-run: its owner (account or guest).
 * An unauthorized subscribe closes the socket with 4403 and a reason; no data is ever sent for it.
 */
export const realtimePlugin: FastifyPluginAsync<RealtimePluginOptions> = async (app, options) => {
  const hub = new RealtimeHub(options);
  const providers = new Map<RealtimeResource, RealtimeProvider[]>();
  const realtime: Realtime = {
    hub,
    provide(resource, provider) {
      const list = providers.get(resource) ?? [];
      list.push(provider);
      providers.set(resource, list);
    },
  };
  app.decorate("realtime", realtime);
  const db = app.services.ctx.db;

  realtime.provide("game", {
    authorize(identity, gameId) {
      const record = gamesRepo.get(db, gameId);
      if (!record || !HTTP_READ_MODES.includes(record.mode)) return false;
      if (identity.kind === "user") return record.ownerUserId === identity.user.id;
      if (identity.kind === "guest") return record.ownerGuestId === identity.guestId;
      return false;
    },
    catchUp(gameId, lastSequence, limit) {
      const record = gamesRepo.get(db, gameId);
      if (!record) return { kind: "events", events: [] };
      if (record.state.revision - lastSequence > limit) return { kind: "resync" };
      const rows = gamesRepo.eventsPage(db, gameId, lastSequence, limit);
      return {
        kind: "events",
        events: rows.map((row) => ({
          resource: "game",
          resourceId: gameId,
          type: "game.updated",
          sequence: row.revision,
          payload: {
            gameId,
            kind: row.kind,
            revision: row.revision,
            status: row.revision === record.state.revision ? record.state.status : "active",
          },
        })),
      };
    },
  });

  realtime.provide("bot-run", {
    authorize(identity, runId) {
      const row = db.prepare("SELECT owner_user_id, owner_guest_id FROM bot_runs WHERE id = ?").get(runId) as
        { owner_user_id: string | null; owner_guest_id: string | null } | undefined;
      if (!row) return false;
      if (identity.kind === "user") return row.owner_user_id === identity.user.id;
      if (identity.kind === "guest") return row.owner_guest_id === identity.guestId;
      return false;
    },
  });

  const unsubscribe = app.services.events.subscribe((event) => hub.publish(publicationOf(event)));

  if (!app.hasDecorator("websocketServer")) {
    await app.register(fastifyWebsocket, { options: { maxPayload: options.maxPayload ?? 4096 } });
  }
  app.addHook("onClose", async () => {
    unsubscribe();
    await hub.close();
  });

  app.get(
    WS_PATH,
    {
      websocket: true,
      // An upgrade refused by ANY hook (including the root security hook, which runs before the
      // websocket plugin marks the request) must release the raw socket, or it lingers and blocks
      // server shutdown.
      onResponse: async (request, reply) => {
        if (reply.statusCode !== 101 && request.headers.upgrade?.toLowerCase() === "websocket") {
          reply.raw.socket?.destroy();
        }
      },
      preValidation: async (request, reply) => {
        // A refused upgrade must not leave a keep-alive socket behind (the plugin destroys it).
        void reply.header("connection", "close");
        const origin = request.headers.origin;
        const verdict = checkSameOrigin(
          {
            host: request.headers.host,
            origin: Array.isArray(origin) ? origin[0] : origin,
            secFetchSite: request.headers["sec-fetch-site"] as string | undefined,
          },
          request.protocol,
          { allowedHosts: null }, // the Host allow-list was already enforced by the root hook
        );
        if (!verdict.ok) {
          request.log.warn({ reason: verdict.reason }, "rejected WebSocket upgrade");
          throw new AppError("FORBIDDEN", "Cross-origin WebSocket rejected");
        }
        if (request.identity.kind === "anonymous") {
          throw new AppError("UNAUTHENTICATED", "Sign in or start a guest session first");
        }
      },
    },
    (socket, request) => {
      const identity: Identity = request.identity;
      hub.attach(socket as unknown as HubSocket, {
        authorize(resource, resourceId) {
          return (providers.get(resource) ?? []).some((p) => {
            try {
              return p.authorize(identity, resourceId);
            } catch {
              return false;
            }
          });
        },
        catchUp(resource, resourceId, lastSequence) {
          for (const p of providers.get(resource) ?? []) {
            const answer = p.catchUp?.(resourceId, lastSequence, hub.catchUpMax);
            if (answer) return answer;
          }
          return { kind: "events", events: [] };
        },
      });
    },
  );
};

// Decorations (app.realtime) must be visible to sibling plugins: same effect as fastify-plugin.
(realtimePlugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
