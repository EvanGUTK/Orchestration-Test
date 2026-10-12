import type { FastifyPluginAsync } from "fastify";
import { PatchProfileRequest } from "@g2048/contracts";
import { parseWith } from "../http/errors.js";
import { requireSession } from "../http/security-hooks.js";
import type { AuthService } from "../services/auth-service.js";

export type ProfileRoutesOptions = { auth: AuthService };

export const profileRoutes: FastifyPluginAsync<ProfileRoutesOptions> = async (app, { auth }) => {
  /** Allowlisted preferences (PreferencesSchema, strict) for accounts and guests; displayName for accounts only. */
  app.patch("/profile", async (request) => {
    const identity = requireSession(request);
    const body = parseWith(PatchProfileRequest, request.body);
    await auth.updateProfile(identity, body);
    return auth.me(identity);
  });
};
