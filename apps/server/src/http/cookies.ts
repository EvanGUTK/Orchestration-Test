import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Session cookies: HttpOnly, SameSite=Strict, Path=/. `Secure` only when the request arrived over
 * TLS (plain-HTTP loopback development cannot carry Secure cookies).
 */
export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  name: string,
  token: string,
  expiresAt: Date,
): void {
  void reply.setCookie(name, token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: request.protocol === "https",
    expires: expiresAt,
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply, name: string): void {
  void reply.clearCookie(name, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: request.protocol === "https",
  });
}
