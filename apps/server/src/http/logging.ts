import type { FastifyServerOptions } from "fastify";

/**
 * Structured local logs. Request/response serializers log only method, url (without query string),
 * id, and status code; redaction is a second line of defence for anything that does reach a log
 * object (cookies, authorization, CSRF tokens, passwords, tokens, hashes).
 */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "headers.cookie",
  "headers.authorization",
  'headers["set-cookie"]',
  'headers["x-csrf-token"]',
  "body.password",
  "body.currentPassword",
  "body.newPassword",
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.passwordHash",
  "*.token",
  "*.sessionToken",
  "*.csrfToken",
  "*.tokenHash",
];

export type LogDestination = { write(chunk: string): void };

export function loggerOptions(
  enabled: boolean | { stream: LogDestination; level?: string },
): FastifyServerOptions["logger"] {
  if (enabled === false) return false;
  const base = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers: {
      req(request: { id?: string; method?: string; url?: string }) {
        return { id: request.id, method: request.method, url: (request.url ?? "").split("?")[0] };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };
  if (enabled === true) return base;
  return { ...base, level: enabled.level ?? base.level, stream: enabled.stream };
}
