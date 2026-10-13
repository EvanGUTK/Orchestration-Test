import type { FastifyPluginAsync } from "fastify";
import {
  API_BASE,
  CreateMatchRequest,
  MoveRequest,
  RevisionCommandRequest,
  type SeatId,
} from "@g2048/contracts";
import { AppError, parseWith } from "../http/errors.js";
import { requireUser } from "../http/security-hooks.js";
import { MatchBotDriver } from "./bot-driver.js";
import { MatchEventLog } from "./event-log.js";
import { MatchService } from "./service.js";

declare module "fastify" {
  interface FastifyInstance {
    matches: { service: MatchService; bots: MatchBotDriver };
  }
}

export type MatchesPluginOptions = {
  /** Pause between bot moves; default 0. */
  botMoveDelayMs?: number;
};

type IdParams = { id: string };
type SeatParams = { id: string; seat: string };

function seatOf(value: string): SeatId {
  if (value !== "a" && value !== "b") throw new AppError("NOT_FOUND", "Seat not found");
  return value;
}

/**
 * Duel matches under /api/v1 (DUEL-01..06). Requires the realtime plugin to be registered first.
 *
 *   POST /matches                         CreateMatchRequest -> 201 MatchDetail
 *   GET  /matches                         { items: MatchDetail[] } (own lobby/active matches + open lobbies)
 *   GET  /matches/:id                     MatchDetail (participants/creator; anyone for an open lobby)
 *   POST /matches/:id/join                -> MatchDetail (second, different account)
 *   POST /matches/:id/seats/:seat/moves   MoveRequest -> MoveResponse
 *   POST /matches/:id/seats/:seat/forfeit RevisionCommandRequest -> MatchDetail (lobby: abandons it)
 *
 * Every route needs a signed-in account (guests cannot play duels). Duel seat games are moved only
 * here; the generic /games routes must refuse duel modes (SEC-R2-02).
 */
export const matchesPlugin: FastifyPluginAsync<MatchesPluginOptions> = async (app, options) => {
  if (!app.hasDecorator("realtime")) throw new Error("register realtimePlugin before matchesPlugin");
  const realtime = app.realtime;
  const eventLog = new MatchEventLog();
  const service = new MatchService(app.services.ctx, app.services.games, app.services.events, eventLog);
  // The process-wide bot pool is created once by buildApp (app.services.bots = createBotServices()).
  const bots = new MatchBotDriver(service, app.services.bots.seats, app.log, {
    moveDelayMs: options.botMoveDelayMs ?? 0,
  });
  service.onBotWork = (matchId) => bots.kick(matchId);
  app.decorate("matches", { service, bots });

  realtime.provide("match", {
    authorize: (identity, matchId) =>
      identity.kind === "user" && service.canWatchMatch(identity.user.id, matchId),
    catchUp: (matchId, lastSequence, limit) =>
      eventLog.catchUp(app.services.ctx.db, matchId, lastSequence, limit),
  });
  // Seat games are not subscribable as games (mode not in HTTP_READ_MODES): both boards reach the
  // players through match.updated payloads (MatchDetail with redacted seat states).

  // Restart recovery (DB-07): finish anything left consistent-but-unfinalized, then re-plan bot seats.
  app.addHook("onReady", async () => {
    for (const matchId of service.activeMatchIds()) {
      try {
        await service.reconcile(matchId);
      } catch (error) {
        app.log.error({ err: error, matchId }, "match recovery failed");
      }
      bots.kick(matchId);
    }
  });
  app.addHook("onClose", async () => {
    bots.stop(); // the pool itself is shut down by buildApp's onClose (BotRunService.shutdown)
  });

  await app.register(
    async (routes) => {
      routes.post("/matches", async (request, reply) => {
        const user = requireUser(request);
        const body = parseWith(CreateMatchRequest, request.body);
        const detail = await service.create(user.user.id, body);
        return reply.code(201).send(detail);
      });

      routes.get("/matches", async (request) => {
        const user = requireUser(request);
        return { items: service.list(user.user.id) };
      });

      routes.get<{ Params: IdParams }>("/matches/:id", async (request) => {
        const user = requireUser(request);
        return service.get(user.user.id, request.params.id);
      });

      routes.post<{ Params: IdParams }>("/matches/:id/join", async (request) => {
        const user = requireUser(request);
        return service.join(user.user.id, request.params.id);
      });

      routes.post<{ Params: SeatParams }>("/matches/:id/seats/:seat/moves", async (request) => {
        const user = requireUser(request);
        const body = parseWith(MoveRequest, request.body);
        return service.move(user.user.id, request.params.id, seatOf(request.params.seat), body);
      });

      routes.post<{ Params: SeatParams }>("/matches/:id/seats/:seat/forfeit", async (request) => {
        const user = requireUser(request);
        const body = parseWith(RevisionCommandRequest, request.body);
        return service.forfeit(user.user.id, request.params.id, seatOf(request.params.seat), body);
      });
    },
    { prefix: API_BASE },
  );
};

(matchesPlugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
