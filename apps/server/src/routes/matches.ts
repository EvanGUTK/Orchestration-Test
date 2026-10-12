import type { FastifyInstance } from "fastify";
import { requirePrincipal, type AppServices } from "../app.ts";
import { createMatchSchema, matchesQuery, parse, uuidParam } from "../schemas.ts";

export function registerMatchRoutes(app: FastifyInstance, s: AppServices): void {
  app.post("/matches", async (req, reply) => {
    const p = requirePrincipal(s, req);
    const view = await s.matches.create(p, parse(createMatchSchema, req.body));
    return reply.status(201).send(view);
  });

  app.get("/matches", async (req) => {
    const p = requirePrincipal(s, req);
    return s.matches.list(p, parse(matchesQuery, req.query, "query"));
  });

  app.post("/matches/:id/join", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.matches.join(p, id);
  });

  app.get("/matches/:id", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.matches.get(p, id);
  });
}
