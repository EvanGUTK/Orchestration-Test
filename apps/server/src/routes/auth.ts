import type { FastifyPluginAsync } from "fastify";
import { ChangePasswordRequest, LoginRequest, RegisterRequest } from "@g2048/contracts";
import { clearSessionCookie, setSessionCookie } from "../http/cookies.js";
import { AppError, parseWith } from "../http/errors.js";
import { requireUser } from "../http/security-hooks.js";
import type { AuthService } from "../services/auth-service.js";
import { GUEST_COOKIE, SESSION_COOKIE } from "../services/identity.js";

export type AuthRoutesOptions = { auth: AuthService };

/** Thin HTTP adapters: validate with contract schemas, call AuthService, shape the response. */
export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, { auth }) => {
  app.get("/auth/me", async (request, reply) => {
    let identity = request.identity;
    if (identity.kind !== "user" && request.cookies[SESSION_COOKIE] !== undefined) {
      clearSessionCookie(request, reply, SESSION_COOKIE); // expired or revoked account session
    }
    if (identity.kind === "anonymous") {
      const guest = await auth.createGuest();
      setSessionCookie(request, reply, GUEST_COOKIE, guest.sessionToken, guest.expiresAt);
      identity = guest;
    }
    return auth.me(identity);
  });

  app.post("/auth/register", async (request, reply) => {
    const body = parseWith(RegisterRequest, request.body);
    const previous = request.identity.kind === "user" ? request.identity.tokenHash : null;
    const { user, session } = await auth.register(body, previous);
    setSessionCookie(request, reply, SESSION_COOKIE, session.token, session.expiresAt);
    return reply.code(201).send(auth.meForNewSession(user, session.token));
  });

  app.post("/auth/login", async (request, reply) => {
    const body = parseWith(LoginRequest, request.body);
    const previous = request.identity.kind === "user" ? request.identity.tokenHash : null;
    const { user, session } = await auth.login(body, request.ip, previous);
    setSessionCookie(request, reply, SESSION_COOKIE, session.token, session.expiresAt);
    return auth.meForNewSession(user, session.token);
  });

  /** `{ "allSessions": true }` clears every session of the account (session clearing). */
  app.post("/auth/logout", async (request, reply) => {
    const body = parseLogout(request.body);
    const identity = request.identity;
    let revokedSessions = 0;
    if (identity.kind === "user") revokedSessions = await auth.logout(identity, body.allSessions ?? false);
    clearSessionCookie(request, reply, SESSION_COOKIE);
    return { ok: true, revokedSessions };
  });

  app.post("/auth/password", async (request) => {
    const identity = requireUser(request);
    const body = parseWith(ChangePasswordRequest, request.body);
    const revokedSessions = await auth.changePassword(identity, body);
    return { ok: true, revokedSessions };
  });
};

/** Server-local (not a CONTRACT-001 schema): optional body `{ allSessions?: boolean }` of POST /auth/logout. */
function parseLogout(body: unknown): { allSessions?: boolean } {
  if (body === undefined || body === null) return {};
  const invalid = new AppError("VALIDATION_ERROR", "Request validation failed", {
    issues: [{ path: "allSessions", message: "Expected an optional boolean allSessions only" }],
  });
  if (typeof body !== "object" || Array.isArray(body)) throw invalid;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "allSessions")) throw invalid;
  if (record.allSessions !== undefined && typeof record.allSessions !== "boolean") throw invalid;
  return record.allSessions === undefined ? {} : { allSessions: record.allSessions };
}
