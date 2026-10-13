import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  CreateBotRunRequest,
  LIMITS,
  LeaderboardQuery,
  type BotRunView,
  type LeaderboardEntry,
  type Page,
  type ReplayFile,
} from "@g2048/contracts";
import type { GameOwnerRef } from "@g2048/database";
import { AppError, importErrorHandler, parseWith } from "../http/errors.js";
import { ensureSession } from "../http/security-hooks.js";
import type { AuthService } from "../services/auth-service.js";
import type { BotRunService } from "../services/bot-run-service.js";
import type { ChallengeService } from "../services/challenge-service.js";
import type { LeaderboardService } from "../services/leaderboard-service.js";
import type { ReplayService } from "../services/replay-service.js";

export type CompetitionRoutesOptions = {
  auth: AuthService;
  challenges: ChallengeService;
  leaderboards: LeaderboardService;
  replays: ReplayService;
  botRuns: BotRunService;
};

type IdParams = { id: string };

function ownerOf(request: FastifyRequest): GameOwnerRef | null {
  const identity = request.identity;
  if (identity.kind === "user") return { userId: identity.user.id };
  if (identity.kind === "guest") return { guestId: identity.guestId };
  return null;
}

function ownerOr404(request: FastifyRequest, what: string): GameOwnerRef {
  const owner = ownerOf(request);
  if (!owner) throw new AppError("NOT_FOUND", `${what} not found`);
  return owner;
}

/**
 * Challenges, leaderboards, replays and bot-lab runs. Request bodies only select WHAT to do; scores,
 * states, rules, and results are always derived by the server (RANK-04): unknown body fields are
 * ignored and never trusted.
 */
export const competitionRoutes: FastifyPluginAsync<CompetitionRoutesOptions> = async (app, opts) => {
  const { auth, challenges, leaderboards, replays, botRuns } = opts;

  app.get("/challenges", async (request) => challenges.list(request.identity));

  /** Starts the official attempt (201) or resumes the in-progress one (200). Account only. */
  app.post<{ Params: IdParams }>("/challenges/:id/attempts", async (request, reply) => {
    const { started, response } = await challenges.startOrResume(request.identity, request.params.id);
    return reply.code(started ? 201 : 200).send(response);
  });

  app.get("/leaderboards", async (request) => {
    const query = parseWith(LeaderboardQuery, request.query);
    const page: Page<LeaderboardEntry> = leaderboards.query(query);
    return page;
  });

  app.get<{ Params: IdParams }>("/replays/:id", async (request) => {
    const file: ReplayFile = replays.export(ownerOf(request), request.params.id);
    return file;
  });

  app.post(
    "/replays/import",
    { bodyLimit: LIMITS.replayImportBytes, errorHandler: importErrorHandler },
    async (request, reply) => {
      const size = Number(request.headers["content-length"] ?? JSON.stringify(request.body ?? null).length);
      const identity = await ensureSession(request, reply, auth);
      const owner: GameOwnerRef =
        identity.kind === "user" ? { userId: identity.user.id } : { guestId: identity.guestId };
      const result = await replays.import(owner, request.body, size);
      return reply.code(201).send(result);
    },
  );

  app.post("/bots/runs", async (request, reply) => {
    const body = parseWith(CreateBotRunRequest, request.body);
    const identity = await ensureSession(request, reply, auth);
    const owner: GameOwnerRef =
      identity.kind === "user" ? { userId: identity.user.id } : { guestId: identity.guestId };
    const view: BotRunView = await botRuns.start(owner, body);
    return reply.code(201).send(view);
  });

  app.get<{ Params: IdParams }>("/bots/runs/:id", async (request) =>
    botRuns.view(ownerOr404(request, "Bot run"), request.params.id),
  );
  app.post<{ Params: IdParams }>("/bots/runs/:id/cancel", async (request) =>
    botRuns.cancel(ownerOr404(request, "Bot run"), request.params.id),
  );
  app.post<{ Params: IdParams }>("/bots/runs/:id/pause", async (request) =>
    botRuns.pause(ownerOr404(request, "Bot run"), request.params.id),
  );
  app.post<{ Params: IdParams }>("/bots/runs/:id/resume", async (request) =>
    botRuns.resume(ownerOr404(request, "Bot run"), request.params.id),
  );
  app.post<{ Params: IdParams }>("/bots/runs/:id/step", async (request) =>
    botRuns.step(ownerOr404(request, "Bot run"), request.params.id),
  );
};
