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
import { setSessionCookie } from "./cookies.js";

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

/** CSP for the bundled UI (SEC-FIX-001 L9). The built SPA has no inline scripts or style attributes. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

/**
 * Root-level hooks (apply to every route registered afterwards, including future feature plugins):
 *  1. every /api request: loopback/allowed Host and no cross-site / same-site Sec-Fetch-Site
 *     (DNS-rebinding and cross-site GET probes are refused before any work, SEC-FIX-001 M2);
 *  2. resolve the caller's identity from the `sid` / `gid` cookies;
 *  3. POST/PUT/PATCH/DELETE: same-origin Origin check, then `x-csrf-token` must match the CSRF token
 *     bound to the caller's session (account, guest, or pending guest token);
 *  4. security headers; API responses are never cached; UI responses carry a CSP.
 */
export function installSecurityHooks(app: FastifyInstance, auth: AuthService, policy: OriginPolicy): void {
  app.decorateRequest("identity", null as never);

  app.addHook("onRequest", async (request) => {
    const mutating = MUTATING.has(request.method);
    if (mutating || isApiPath(request.url)) {
      const verdict = checkSameOrigin(
        {
          host: headerValue(request.headers.host),
          // Origin is only meaningful for state-changing requests; GETs are checked by Host + Fetch metadata.
          origin: mutating ? headerValue(request.headers.origin) : undefined,
          secFetchSite: headerValue(request.headers["sec-fetch-site"]),
        },
        request.protocol,
        policy,
      );
      if (!verdict.ok) {
        request.identity = { kind: "anonymous", pendingToken: null, csrfToken: null };
        request.log.warn({ reason: verdict.reason }, "rejected cross-origin request");
        throw new AppError("FORBIDDEN", "Cross-origin request rejected");
      }
    }
    request.identity = auth.resolve(request.cookies[SESSION_COOKIE], request.cookies[GUEST_COOKIE]);
    if (!mutating) return;
    const expected = request.identity.csrfToken;
    if (!expected) {
      throw new AppError("FORBIDDEN", "Missing session; call GET /api/v1/auth/me to obtain a CSRF token");
    }
    const supplied = headerValue(request.headers[CSRF_HEADER]);
    if (!supplied || !safeEqual(supplied, expected)) {
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
    } else {
      void reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
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

/**
 * For guest-owned actions: returns the caller's account/guest identity, creating the guest row and
 * session lazily (from the pending `gid` token) for an anonymous caller. Never runs for cross-site
 * requests because the onRequest hook rejects them first.
 */
export async function ensureSession(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
): Promise<UserIdentity | GuestIdentity> {
  const identity = request.identity;
  if (identity.kind !== "anonymous") return identity;
  const guest = await auth.createGuest(identity, request.ip);
  setSessionCookie(request, reply, GUEST_COOKIE, guest.sessionToken, guest.expiresAt);
  request.identity = guest;
  return guest;
}
