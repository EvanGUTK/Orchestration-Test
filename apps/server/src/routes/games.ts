import type { FastifyInstance } from "fastify";
import {
  createGameSchema, eventsQuery, forfeitSchema, listGamesQuery, moveSchema, parse, undoSchema, uuidParam,
} from "../schemas.ts";
import { requirePrincipal, type AppServices } from "../app.ts";
import { ownerOf } from "../services/games.ts";

export function registerGameRoutes(app: FastifyInstance, s: AppServices): void {
  app.post("/games", async (req, reply) => {
    const p = requirePrincipal(s, req);
    const body = parse(createGameSchema, req.body);
    const view = await s.games.create(ownerOf(p), body);
    return reply.status(201).send(view);
  });

  app.get("/games", async (req) => {
    const p = requirePrincipal(s, req);
    return s.games.list(ownerOf(p), parse(listGamesQuery, req.query, "query"));
  });

  app.get("/games/:id", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.games.get(ownerOf(p), id);
  });

  app.post("/games/:id/moves", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.games.move(ownerOf(p), id, parse(moveSchema, req.body));
  });

  app.post("/games/:id/undo", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.games.undo(ownerOf(p), id, parse(undoSchema, req.body));
  });

  app.post("/games/:id/forfeit", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.games.forfeit(ownerOf(p), id, parse(forfeitSchema, req.body));
  });

  app.get("/games/:id/events", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.games.events(ownerOf(p), id, parse(eventsQuery, req.query, "query"));
  });
}
