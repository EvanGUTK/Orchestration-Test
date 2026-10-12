import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  CreateGameRequest,
  EventsQuery,
  MoveRequest,
  PageQuery,
  RevisionCommandRequest,
  type GameEventsResponse,
  type GameResponse,
  type GameSummary,
  type MoveResponse,
  type Page,
} from "@g2048/contracts";
import type { GameOwnerRef } from "@g2048/database";
import { AppError, parseWith } from "../http/errors.js";
import { ensureSession } from "../http/security-hooks.js";
import type { AuthService } from "../services/auth-service.js";
import type { GameService } from "../services/game-service.js";

export type GameRoutesOptions = { auth: AuthService; games: GameService };

/** Owner reference of the caller, or null for an anonymous caller (who owns nothing). */
function ownerOf(request: FastifyRequest): GameOwnerRef | null {
  const identity = request.identity;
  if (identity.kind === "user") return { userId: identity.user.id };
  if (identity.kind === "guest") return { guestId: identity.guestId };
  return null;
}

function ownerOr404(request: FastifyRequest): GameOwnerRef {
  const owner = ownerOf(request);
  if (!owner) throw new AppError("NOT_FOUND", "Game not found");
  return owner;
}

type IdParams = { id: string };

/** Thin adapters over GameService; the server never accepts client-supplied state or scores. */
export const gameRoutes: FastifyPluginAsync<GameRoutesOptions> = async (app, { auth, games }) => {
  /** classic (optional seed) or practice (PracticeOptions). Guests allowed; always casual. */
  app.post("/games", async (request, reply) => {
    const body = parseWith(CreateGameRequest, request.body);
    const identity = await ensureSession(request, reply, auth);
    const owner: GameOwnerRef =
      identity.kind === "user" ? { userId: identity.user.id } : { guestId: identity.guestId };
    const response: GameResponse = await games.create(owner, body);
    return reply.code(201).send(response);
  });

  app.get("/games", async (request) => {
    const query = parseWith(PageQuery, request.query);
    const owner = ownerOf(request);
    const page: Page<GameSummary> = owner ? games.list(owner, query) : { items: [], nextCursor: null };
    return page;
  });

  app.get<{ Params: IdParams }>("/games/:id", async (request) => {
    const response: GameResponse = games.get(ownerOr404(request), request.params.id);
    return response;
  });

  app.post<{ Params: IdParams }>("/games/:id/moves", async (request) => {
    const body = parseWith(MoveRequest, request.body);
    const response: MoveResponse = await games.move(ownerOr404(request), request.params.id, body);
    return response;
  });

  app.post<{ Params: IdParams }>("/games/:id/undo", async (request) => {
    const body = parseWith(RevisionCommandRequest, request.body);
    const response: GameResponse = await games.undo(ownerOr404(request), request.params.id, body);
    return response;
  });

  app.post<{ Params: IdParams }>("/games/:id/forfeit", async (request) => {
    const body = parseWith(RevisionCommandRequest, request.body);
    const response: GameResponse = await games.forfeit(ownerOr404(request), request.params.id, body);
    return response;
  });

  app.get<{ Params: IdParams }>("/games/:id/events", async (request) => {
    const query = parseWith(EventsQuery, request.query);
    const response: GameEventsResponse = games.events(ownerOr404(request), request.params.id, query);
    return response;
  });
};
