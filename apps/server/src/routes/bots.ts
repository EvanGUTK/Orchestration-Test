import type { FastifyInstance } from "fastify";
import { requirePrincipal, type AppServices } from "../app.ts";
import { botRunSchema, parse, uuidParam } from "../schemas.ts";
import type { BotAction } from "../services/bots.ts";

export function registerBotRoutes(app: FastifyInstance, s: AppServices): void {
  app.post("/bots/runs", async (req, reply) => {
    const p = requirePrincipal(s, req);
    const view = await s.bots.start(p, parse(botRunSchema, req.body));
    return reply.status(201).send(view);
  });

  app.get("/bots/runs/:id", async (req) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(uuidParam, req.params, "path");
    return s.bots.get(p, id);
  });

  for (const action of ["pause", "resume", "step", "cancel"] as const satisfies readonly BotAction[]) {
    app.post(`/bots/runs/:id/${action}`, async (req) => {
      const p = requirePrincipal(s, req);
      const { id } = parse(uuidParam, req.params, "path");
      return s.bots.control(p, id, action);
    });
  }
}
