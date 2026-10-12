import type { FastifyInstance } from "fastify";
import {
  changePasswordSchema, deleteProfileSchema, loginSchema, parse, patchProfileSchema, registerSchema,
} from "../schemas.ts";
import { clearSessionCookie, principalsOf, requirePrincipal, setSessionCookie, type AppServices } from "../app.ts";
import { unauthenticated } from "../errors.ts";

export function registerAuthRoutes(app: FastifyInstance, s: AppServices): void {
  app.post("/auth/register", async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const { user } = principalsOf(s, req);
    const issued = await s.accounts.register(body, req.ip, user ?? undefined);
    setSessionCookie(s, reply, "user", issued.token, issued.maxAgeSec);
    return reply.status(201).send(issued.identity);
  });

  app.post("/auth/login", async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const { user } = principalsOf(s, req);
    const issued = await s.accounts.login(body, req.ip, user ?? undefined);
    setSessionCookie(s, reply, "user", issued.token, issued.maxAgeSec);
    return issued.identity;
  });

  app.post("/auth/guest", async (req, reply) => {
    const existing = principalsOf(s, req).guest;
    if (existing) return s.accounts.identityOf(existing);
    const issued = await s.accounts.createGuest(req.ip);
    setSessionCookie(s, reply, "guest", issued.token, issued.maxAgeSec);
    return reply.status(201).send(issued.identity);
  });

  app.post("/auth/logout", async (req, reply) => {
    const { user, guest } = principalsOf(s, req);
    if (!user && !guest) throw unauthenticated();
    const p = requirePrincipal(s, req);
    await s.accounts.logout(p);
    clearSessionCookie(s, reply, p.kind);
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const p = requirePrincipal(s, req);
    return s.accounts.identityOf(p);
  });

  app.post("/auth/password", async (req) => {
    const p = requirePrincipal(s, req, { userOnly: true });
    const body = parse(changePasswordSchema, req.body);
    await s.accounts.changePassword(p, body.oldPassword, body.newPassword);
    return { ok: true };
  });

  app.patch("/profile", async (req) => {
    const p = requirePrincipal(s, req, { userOnly: true });
    const body = parse(patchProfileSchema, req.body);
    return s.accounts.patchProfile(p, body);
  });

  app.delete("/profile", async (req, reply) => {
    const p = requirePrincipal(s, req, { userOnly: true });
    const body = parse(deleteProfileSchema, req.body);
    await s.accounts.deleteProfile(p, body.password);
    clearSessionCookie(s, reply, "user");
    return { ok: true };
  });
}
