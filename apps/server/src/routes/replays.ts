import type { FastifyInstance } from "fastify";
import { requirePrincipal, type AppServices } from "../app.ts";
import { parse, replaysQuery, uuidParam } from "../schemas.ts";
import { IMPORT_MAX_BYTES } from "../services/replays.ts";

export function registerReplayRoutes(app: FastifyInstance, s: AppServices): void {
  app.get("/replays", async (req) => {
    const p = requirePrincipal(s, req);
    return s.replays.list(p, parse(replaysQuery, req.query, "query"));
  });

  app.post("/replays/import", { bodyLimit: IMPORT_MAX_BYTES }, async (req, reply) => {
    const p = requirePrincipal(s, req);
    const summary = await s.replays.import(p, req.body);
    return reply.status(201).send(summary);
  });

  app.get("/replays/:id", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.replays.get(p, id);
  });
}
