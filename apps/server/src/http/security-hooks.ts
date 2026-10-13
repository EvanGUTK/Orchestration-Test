import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_BASE } from "@g2048/contracts";
import { AppError } from "./errors.js";
import type { AuthService } from "../services/auth-service.js";
import {
  GUEST_COOKIE,
  SESSION_COOKIE,
  type GuestIdentity,
  type Identity,
  type UserIdentity,
} from "../services/identity.js";
import { checkHost, checkSameOrigin, type OriginPolicy } from "../security/origin.js";
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

function decodedPath(url: string): string | null {
  try {
    return decodeURIComponent(url.split("?")[0] ?? "");
  } catch {
    return null;
  }
}

/**
 * Whether a request targets the API, decided from the MATCHED route (Fastify matches on the decoded
 * path, so `/%61pi/...` is an API route). Unmatched requests fall back to the decoded path and fail
 * closed: anything undecodable or under `/api` counts as API (SEC-FIX-002 R2-01).
 */
export function isApiRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (route) return route.startsWith(API_BASE);
  const path = decodedPath(request.url);
  return path === null || path.toLowerCase().startsWith("/api");
}

/** A matched non-API route (a bundled static file); everything else gets no-store. */
function isStaticFile(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  return Boolean(route) && !(route as string).startsWith(API_BASE) && !request.is404;
}

/** A top-level page load (link click / typed URL) of the UI, the only cross-site request allowed. */
function isDocumentNavigation(request: FastifyRequest): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    headerValue(request.headers["sec-fetch-mode"]) === "navigate" &&
    (headerValue(request.headers["sec-fetch-dest"]) ?? "document") === "document" &&
    !isApiRequest(request)
  );
}

/**
 * Root-level hooks (apply to every request, including static files and 404s):
 *  1. Host must be an allowed loopback host (DNS rebinding), on EVERY request;
 *  2. `Sec-Fetch-Site: cross-site | same-site` is rejected on every request except a top-level
 *     navigation to a UI page (SEC-FIX-002 R2-01: API-ness comes from the matched route, never the
 *     raw URL);
 *  3. POST/PUT/PATCH/DELETE: same-origin Origin, then `x-csrf-token` bound to the caller's session
 *     (account, guest, or server-issued pending guest token);
 *  4. headers: CSP, CORP and nosniff everywhere; `no-store` on everything except static files.
 */
export function installSecurityHooks(app: FastifyInstance, auth: AuthService, policy: OriginPolicy): void {
  app.decorateRequest("identity", null as never);

  app.addHook("onRequest", async (request) => {
    request.identity = { kind: "anonymous", pendingToken: null, csrfToken: null };
    const mutating = MUTATING.has(request.method);
    const host = checkHost(headerValue(request.headers.host), policy);
    const site = headerValue(request.headers["sec-fetch-site"])?.toLowerCase();
    const crossSite = (site === "cross-site" || site === "same-site") && !isDocumentNavigation(request);
    const verdict = !host.ok
      ? host
      : crossSite
        ? ({ ok: false, reason: "cross-site request" } as const)
        : mutating
          ? checkSameOrigin(
              {
                host: headerValue(request.headers.host),
                origin: headerValue(request.headers.origin),
                secFetchSite: site,
              },
              request.protocol,
              policy,
            )
          : ({ ok: true } as const);
    if (!verdict.ok) {
      request.log.warn({ reason: verdict.reason }, "rejected cross-origin request");
      throw new AppError("FORBIDDEN", "Cross-origin request rejected");
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

  // A WebSocket upgrade refused by any hook (Host, fetch metadata, CSRF, 404...) must not leave the raw
  // socket open: it would linger and block server shutdown.
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode !== 101 && headerValue(request.headers.upgrade)?.toLowerCase() === "websocket") {
      request.raw.socket?.destroy();
    }
  });

  app.addHook("onSend", async (request, reply: FastifyReply) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("x-frame-options", "DENY");
    void reply.header("referrer-policy", "no-referrer");
    void reply.header("cross-origin-opener-policy", "same-origin");
    void reply.header("cross-origin-resource-policy", "same-origin");
    void reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
    if (!isStaticFile(request)) void reply.header("cache-control", "no-store");
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
