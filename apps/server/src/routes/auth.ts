import type { FastifyPluginAsync } from "fastify";
import {
  ChangePasswordRequest,
  LoginRequest,
  LogoutRequest,
  PASSWORD_MAX,
  RegisterRequest,
  type AuthResponse,
  type RevokeResponse,
} from "@g2048/contracts";
import { clearSessionCookie, setSessionCookie } from "../http/cookies.js";
import { AppError, parseWith } from "../http/errors.js";
import { requireUser } from "../http/security-hooks.js";
import type { AuthService } from "../services/auth-service.js";
import { GUEST_COOKIE, SESSION_COOKIE } from "../services/identity.js";

export type AuthRoutesOptions = { auth: AuthService };

/** Thin HTTP adapters: validate with contract schemas, call AuthService, shape the response. */
export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, { auth }) => {
  /**
   * Current identity + CSRF token. An anonymous caller receives an unregistered `gid` token (no
   * database write); a guest row is created only when a guest-owned action needs it.
   */
  app.get("/auth/me", async (request, reply) => {
    let identity = request.identity;
    if (identity.kind !== "user" && request.cookies[SESSION_COOKIE] !== undefined) {
      clearSessionCookie(request, reply, SESSION_COOKIE); // expired or revoked account session
    }
    if (identity.kind === "anonymous" && identity.pendingToken === null) {
      const pending = auth.issuePendingGuestToken();
      setSessionCookie(request, reply, GUEST_COOKIE, pending.token, pending.expiresAt);
      identity = { kind: "anonymous", pendingToken: pending.token, csrfToken: pending.csrfToken };
    }
    return auth.me(identity);
  });

  app.post("/auth/register", async (request, reply) => {
    const body = parseWith(RegisterRequest, request.body);
    const previous = request.identity.kind === "user" ? request.identity.tokenHash : null;
    const { user, session } = await auth.register(body, request.ip, previous);
    setSessionCookie(request, reply, SESSION_COOKIE, session.token, session.expiresAt);
    const response: AuthResponse = auth.meForNewSession(user, session.token);
    return reply.code(201).send(response);
  });

  app.post("/auth/login", async (request, reply) => {
    const body = parseWith(LoginRequest, request.body);
    const previous = request.identity.kind === "user" ? request.identity.tokenHash : null;
    const { user, session } = await auth.login(body, request.ip, previous);
    setSessionCookie(request, reply, SESSION_COOKIE, session.token, session.expiresAt);
    const response: AuthResponse = auth.meForNewSession(user, session.token);
    return response;
  });

  /** `{ "allSessions": true }` clears every session of the account (CONTRACT-001 C8). */
  app.post("/auth/logout", async (request, reply) => {
    const body = parseWith(LogoutRequest, request.body ?? {});
    const identity = request.identity;
    let revokedSessions = 0;
    if (identity.kind === "user") revokedSessions = await auth.logout(identity, body.allSessions ?? false);
    clearSessionCookie(request, reply, SESSION_COOKIE);
    const response: RevokeResponse = { ok: true, revokedSessions };
    return response;
  });

  app.post("/auth/password", async (request) => {
    const identity = requireUser(request);
    const body = parseWith(ChangePasswordRequest, request.body);
    // Cap the unverified current password before spending Argon2 work on it (SEC-FIX-001 L3).
    if ([...body.currentPassword].length > PASSWORD_MAX) {
      throw new AppError("VALIDATION_ERROR", "Current password is incorrect", { field: "currentPassword" });
    }
    const revokedSessions = await auth.changePassword(identity, body);
    const response: RevokeResponse = { ok: true, revokedSessions };
    return response;
  });
};
