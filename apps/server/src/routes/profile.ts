import type { FastifyPluginAsync } from "fastify";
import { PatchProfileRequest } from "@g2048/contracts";
import { AppError, parseWith } from "../http/errors.js";
import { ensureSession } from "../http/security-hooks.js";
import type { AuthService } from "../services/auth-service.js";

export type ProfileRoutesOptions = { auth: AuthService };

export const profileRoutes: FastifyPluginAsync<ProfileRoutesOptions> = async (app, { auth }) => {
  /**
   * Allowlisted preferences (PreferencesSchema, strict) for accounts and guests; displayName for
   * accounts only. An anonymous caller becomes a guest here (preferences persist per guest).
   */
  app.patch("/profile", async (request, reply) => {
    const body = parseWith(PatchProfileRequest, request.body);
    if (request.identity.kind !== "user" && body.displayName !== undefined) {
      throw new AppError("FORBIDDEN", "Guests do not have a display name; create an account");
    }
    const identity = await ensureSession(request, reply, auth);
    await auth.updateProfile(identity, body);
    return auth.me(identity);
  });
};
