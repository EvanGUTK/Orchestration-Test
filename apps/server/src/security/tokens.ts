import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit random bearer token, base64url (43 chars). Only its SHA-256 hash is persisted. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

/**
 * CSRF token bound to one session: HMAC-SHA256 keyed by the session's raw token. It is derivable
 * only by the holder of the HttpOnly cookie's value (i.e. the server), changes with every new
 * session, and needs no extra storage.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update("g2048/csrf/v1").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
