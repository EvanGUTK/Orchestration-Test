import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, isApiPath } from "./errors.js";
import type { AuthService } from "../services/auth-service.js";
import {
  GUEST_COOKIE,
  SESSION_COOKIE,
  type GuestIdentity,
  type Identity,
  type UserIdentity,
} from "../services/identity.js";
import { checkSameOrigin, type OriginPolicy } from "../security/origin.js";
import { safeEqual } from "../security/tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    identity: Identity;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSRF_HEADER = "x-csrf-token";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Root-level hooks (apply to every route registered afterwards, including future feature plugins):
 *  1. resolve the caller's identity from the `sid` / `gid` cookies;
 *  2. for POST/PUT/PATCH/DELETE: same-origin check, then `x-csrf-token` must match the CSRF token
 *     bound to the active session (account if logged in, else guest);
 *  3. security headers; API responses are never cached.
 */
export function installSecurityHooks(app: FastifyInstance, auth: AuthService, policy: OriginPolicy): void {
  app.decorateRequest("identity", null as never);

  app.addHook("onRequest", async (request) => {
    request.identity = auth.resolve(request.cookies[SESSION_COOKIE], request.cookies[GUEST_COOKIE]);
    if (!MUTATING.has(request.method)) return;
    const verdict = checkSameOrigin(
      {
        host: headerValue(request.headers.host),
        origin: headerValue(request.headers.origin),
        secFetchSite: headerValue(request.headers["sec-fetch-site"]),
      },
      request.protocol,
      policy,
    );
    if (!verdict.ok) {
      request.log.warn({ reason: verdict.reason }, "rejected cross-origin request");
      throw new AppError("FORBIDDEN", "Cross-origin request rejected");
    }
    const identity = request.identity;
    if (identity.kind === "anonymous") {
      throw new AppError("FORBIDDEN", "Missing session; call GET /api/v1/auth/me to obtain a CSRF token");
    }
    const supplied = headerValue(request.headers[CSRF_HEADER]);
    if (!supplied || !safeEqual(supplied, identity.csrfToken)) {
      throw new AppError("FORBIDDEN", "Missing or invalid CSRF token");
    }
  });

  app.addHook("onSend", async (request, reply: FastifyReply) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("x-frame-options", "DENY");
    void reply.header("referrer-policy", "no-referrer");
    void reply.header("cross-origin-opener-policy", "same-origin");
    if (isApiPath(request.url)) {
      void reply.header("cache-control", "no-store");
      void reply.header("cross-origin-resource-policy", "same-origin");
    }
  });
}

export function requireUser(request: FastifyRequest): UserIdentity {
  if (request.identity.kind !== "user") throw new AppError("UNAUTHENTICATED", "Sign in to a local account");
  return request.identity;
}

export function requireSession(request: FastifyRequest): UserIdentity | GuestIdentity {
  if (request.identity.kind === "anonymous") throw new AppError("UNAUTHENTICATED", "No active session");
  return request.identity;
}
