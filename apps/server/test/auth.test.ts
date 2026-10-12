import { describe, expect, it } from "vitest";
import { Client, HOST_HEADER, ORIGIN, startApp } from "./helpers.ts";

describe("accounts and sessions", { timeout: 30_000 }, () => {
  it("registers, reads identity, logs out, and logs back in", async () => {
    const { app, db } = await startApp();
    const c = new Client(app);
    const reg = await c.register("Alice_01", "correct horse battery", "Alice  A.");
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ kind: "user", username: "alice_01", displayName: "Alice A." });
    expect(reg.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(reg.body)).not.toMatch(/hash|argon2|password/i);

    const setCookie = String(reg.headers["set-cookie"]);
    expect(setCookie).toMatch(/sid=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);

    const me = await c.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(reg.body.userId);
    expect(me.body.preferences.theme).toBe("system");

    // password is argon2id with a per-user salt; session token is stored only as a hash
    const row = db.raw.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$m=\d+,[tp]=\d+,[tp]=\d+\$[A-Za-z0-9+/]+\$/);
    const token = c.cookies.get("sid")!;
    const sess = db.raw.prepare("SELECT token_hash FROM sessions").get() as { token_hash: string };
    expect(sess.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sess.token_hash).not.toContain(token);
    expect(Buffer.from(token, "base64url").length).toBe(32); // 256-bit token

    expect((await c.post("/auth/logout")).status).toBe(200);
    expect((await c.get("/auth/me")).status).toBe(401);
    const old = new Client(app);
    old.cookies.set("sid", token);
    expect((await old.get("/auth/me")).status).toBe(401); // revoked server side

    expect((await c.login("alice_01")).status).toBe(200);
    expect((await c.get("/auth/me")).status).toBe(200);
  });

  it("normalizes usernames and rejects duplicates in any case variant", async () => {
    const { app } = await startApp();
    expect((await new Client(app).register("Bob_Smith")).status).toBe(201);
    for (const variant of ["bob_smith", "BOB_SMITH", " Bob_Smith "]) {
      const r = await new Client(app).register(variant);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect((await new Client(app).login("BOB_smith")).status).toBe(200);
  });

  it("enforces input limits and text-safe display names", async () => {
    const { app } = await startApp();
    const c = new Client(app);
    const bad = async (b: Record<string, unknown>) => (await c.post("/auth/register", b)).status;
    expect(await bad({ username: "ab", displayName: "x", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "a".repeat(25), displayName: "x", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "dot.name", displayName: "x", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "dash-name", displayName: "x", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "ünïcode", displayName: "x", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "a".repeat(24), displayName: "x".repeat(48), password: "p".repeat(128) })).toBe(201);
    expect(await bad({ username: "has space", displayName: "x", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "okname", displayName: "<script>", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "okname", displayName: "bad\u0000name", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "okname", displayName: "x".repeat(49), password: "longenough123" })).toBe(400);
    expect(await bad({ username: "okname", displayName: "", password: "longenough123" })).toBe(400);
    expect(await bad({ username: "okname", displayName: "x", password: "short-11-ch" })).toBe(400);
    expect(await bad({ username: "okname", displayName: "x", password: "p".repeat(129) })).toBe(400);
    expect(await bad({ username: "okname", displayName: "x", password: "longenough123", admin: true })).toBe(400);
    expect(await bad({ username: "okname", displayName: "Zoë 🎮", password: "longenough123" })).toBe(201);
  });

  it("gives identical generic failures for unknown users and wrong passwords", async () => {
    const { app } = await startApp();
    await new Client(app).register("carol");
    const a = await new Client(app).login("carol", "wrong-password");
    const b = await new Client(app).login("nobody-here", "wrong-password");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe("UNAUTHENTICATED");
    expect(a.body.error.message).toBe(b.body.error.message);
    expect(a.body.error.details).toBeUndefined();
  });

  it("rate-limits repeated login failures and recovers only after the window", async () => {
    const { app } = await startApp({ LOGIN_FAILURES_PER_USER: "3" });
    await new Client(app).register("dave");
    const c = new Client(app);
    for (let i = 0; i < 3; i++) expect((await c.login("dave", "nope-nope")).status).toBe(401);
    const blocked = await c.login("dave", "correct horse battery");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // other accounts are unaffected
    await new Client(app).register("erin");
    expect((await new Client(app).login("erin")).status).toBe(200);
  });

  it("changes password: old fails, new works, other sessions are revoked, current stays", async () => {
    const { app } = await startApp();
    const a = new Client(app);
    await a.register("frank");
    const b = new Client(app);
    await b.login("frank");
    expect((await b.get("/auth/me")).status).toBe(200);

    expect((await a.post("/auth/password", { oldPassword: "wrong-wrong", newPassword: "brand new secret!" })).status).toBe(401);
    expect((await a.post("/auth/password", { oldPassword: "correct horse battery", newPassword: "brand new secret!" })).status).toBe(200);
    expect((await a.get("/auth/me")).status).toBe(200);
    expect((await b.get("/auth/me")).status).toBe(401);
    expect((await new Client(app).login("frank", "correct horse battery")).status).toBe(401);
    expect((await new Client(app).login("frank", "brand new secret!")).status).toBe(200);
  });

  it("clears all other sessions on request and keeps the current one", async () => {
    const { app } = await startApp();
    const a = new Client(app);
    await a.register("sessionuser");
    const b = new Client(app);
    await b.login("sessionuser");
    const c = new Client(app);
    await c.login("sessionuser");
    expect((await a.del("/auth/sessions")).status).toBe(200);
    expect((await a.get("/auth/me")).status).toBe(200);
    expect((await b.get("/auth/me")).status).toBe(401);
    expect((await c.get("/auth/me")).status).toBe(401);
  });

  it("patches profile with an allowlist and validates preferences", async () => {
    const { app } = await startApp();
    const c = new Client(app);
    await c.register("gina");
    const ok = await c.patch("/profile", { displayName: "Gina G", preferences: { theme: "dark", motion: "reduced" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ displayName: "Gina G", preferences: { theme: "dark", motion: "reduced", soundMuted: false } });
    expect((await c.get("/auth/me")).body.preferences.theme).toBe("dark");
    expect((await c.patch("/profile", { preferences: { theme: "neon" } })).status).toBe(400);
    expect((await c.patch("/profile", { password_hash: "x" })).status).toBe(400);
    expect((await c.patch("/profile", { username: "hacker" })).status).toBe(400);
    expect((await c.patch("/profile", {})).status).toBe(400);
  });

  it("deletes a profile after re-authentication and anonymizes it", async () => {
    const { app, db } = await startApp();
    const c = new Client(app);
    const reg = await c.register("henry");
    const g = await c.post("/games", { mode: "classic" });
    expect(g.status).toBe(201);
    expect((await c.del("/profile", { password: "wrong-wrong" })).status).toBe(401);
    expect((await c.del("/profile", { password: "correct horse battery" })).status).toBe(200);
    expect((await c.get("/auth/me")).status).toBe(401);
    expect((await new Client(app).login("henry")).status).toBe(401);
    expect(db.raw.prepare("SELECT count(*) AS n FROM games").get()).toEqual({ n: 0 });
    const row = db.raw.prepare("SELECT display_name, password_hash FROM users WHERE id = ?").get(reg.body.userId);
    expect(row).toEqual({ display_name: "Deleted player", password_hash: "" });
    // the username becomes available again
    expect((await new Client(app).register("henry")).status).toBe(201);
  });

  it("keeps guests separate from accounts", async () => {
    const { app } = await startApp();
    const user = new Client(app);
    await user.register("irene");
    const game = (await user.post("/games", { mode: "classic" })).body;

    const guest = new Client(app);
    const g = await guest.guest();
    expect(g.status).toBe(201);
    expect(g.body.kind).toBe("guest");
    expect(g.body.username).toBeUndefined();
    expect((await guest.guest()).status).toBe(200); // reuses the existing guest session
    expect((await guest.get(`/games/${game.id}`)).status).toBe(404);
    expect((await guest.get("/games")).body.items).toEqual([]);
    expect((await guest.patch("/profile", { displayName: "x" })).status).toBe(403);
    const mine = await guest.post("/games", { mode: "classic" });
    expect(mine.status).toBe(201);
    expect((await user.get(`/games/${mine.body.id}`)).status).toBe(404);
  });
});

describe("CSRF, Origin, Host", { timeout: 30_000 }, () => {
  it("rejects foreign Origin on mutating requests, including login/register", async () => {
    const { app } = await startApp();
    const evil = new Client(app, "https://evil.example");
    expect((await evil.register("mallory")).status).toBe(403);
    expect((await new Client(app, "http://localhost:9999").login("x", "y")).status).toBe(403);
    expect((await new Client(app, "null").login("x", "y")).status).toBe(403);
    const ok = new Client(app, "http://localhost:5411");
    expect((await ok.register("trusted_web")).status).toBe(201);
    const noOrigin = new Client(app, null);
    expect((await noOrigin.login("trusted_web")).status).toBe(200);
  });

  it("rejects sec-fetch-site cross-site without Origin", async () => {
    const { app } = await startApp();
    const c = new Client(app, null);
    const r = await c.raw("POST", "/api/v1/auth/login", { username: "a", password: "b" }, { "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
  });

  it("requires the session-bound CSRF token for authenticated mutations", async () => {
    const { app } = await startApp();
    const c = new Client(app);
    await c.register("jack");
    expect((await c.raw("POST", "/api/v1/games", { mode: "classic" }, {}, { csrf: false })).status).toBe(403);
    expect((await c.raw("POST", "/api/v1/games", { mode: "classic" }, { "x-csrf-token": "0".repeat(64) })).status).toBe(403);
    const other = new Client(app);
    await other.register("kate");
    expect((await c.raw("POST", "/api/v1/games", { mode: "classic" }, { "x-csrf-token": other.csrf })).status).toBe(403);
    expect((await c.post("/games", { mode: "classic" })).status).toBe(201);
    expect((await c.raw("POST", "/api/v1/auth/logout", {}, {}, { csrf: false })).status).toBe(403);
  });

  it("rejects untrusted Host headers (DNS rebinding) and non-JSON bodies", async () => {
    const { app } = await startApp();
    const r = await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: "evil.example:5511" } });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error.code).toBe("FORBIDDEN");
    const ok = await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: HOST_HEADER } });
    expect(ok.statusCode).toBe(200);
    const form = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      headers: { host: HOST_HEADER, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, payload: "username=a&password=b",
    });
    expect(form.statusCode).toBe(415);
    expect(JSON.parse(form.body).error.code).toBe("VALIDATION_ERROR");
  });

  it("does not emit CORS allow headers", async () => {
    const { app } = await startApp();
    const r = await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: HOST_HEADER, origin: "https://evil.example" } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
