import type { FastifyInstance } from "fastify";
import type { ProfileStats } from "@2048/contracts";
import { principalsOf, requirePrincipal, type AppServices } from "../app.ts";
import { challengesQuery, leaderboardQuery, parse } from "../schemas.ts";
import { z } from "zod";

const EMPTY_STATS: ProfileStats = {
  gamesPlayed: 0, bestScore: null, bestScoreGameId: null, maxExponent: null, scoreDistribution: [], maxTileCounts: [],
  duels: { won: 0, drawn: 0, lost: 0, rating: null }, rankedHistory: [], bot: { runs: 0, byStrategy: {} },
};

const challengeParam = z.strictObject({ id: z.string().min(1).max(128) });

export function registerCompetitionRoutes(app: FastifyInstance, s: AppServices): void {
  // Catalog and boards are public local data; personalization appears only when a session is present.
  app.get("/challenges", async (req) => {
    const { user, guest } = principalsOf(s, req);
    return s.competition.listChallenges(user ?? guest, parse(challengesQuery, req.query, "query"));
  });

  app.post("/challenges/:id/attempts", async (req, reply) => {
    const p = requirePrincipal(s, req);
    const { id } = parse(challengeParam, req.params, "path");
    const { game, created } = await s.competition.startAttempt(p, id);
    return reply.status(created ? 201 : 200).send(game);
  });

  app.get("/leaderboards", async (req) => s.competition.leaderboard(parse(leaderboardQuery, req.query, "query")));

  app.get("/profile/stats", async (req) => {
    const p = requirePrincipal(s, req);
    return p.kind === "user" ? s.competition.profileStats(p.userId) : EMPTY_STATS;
  });

  app.get("/profile/export", async (req, reply) => {
    const p = requirePrincipal(s, req);
    const data = s.competition.exportProfile(p);
    void reply.header("content-disposition", 'attachment; filename="2048-infinite-profile-export.json"');
    return data;
  });
}

