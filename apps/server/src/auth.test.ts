import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { API_BASE, LIMITS } from "@g2048/contracts";
import { ownerResetPassword } from "./owner-reset.js";
import { PasswordHasher, type PasswordParams } from "./security/passwords.js";
import { removeDir, startTestServer, TEST_HOST, TestClient, type TestServer } from "./test-support.js";

const PASSWORD = "correct horse battery";
const servers: TestServer[] = [];
const dirs = new Set<string>();

async function server(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(options);
  servers.push(s);
  dirs.add(s.dir);
  return s;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const dir of dirs) removeDir(dir);
  dirs.clear();
});

type ErrorBody = {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
};

function expectEnvelope(
  res: { statusCode: number; json: () => unknown; body: string },
  status: number,
  code: string,
) {
  expect(res.statusCode, res.body).toBe(status);
  const body = res.json() as ErrorBody;
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.body).not.toMatch(/stack|at .*\(|\.ts:\d+/);
  return body;
}

function setCookieHeaders(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
}

describe("ACC-01 register / login / logout / password change", () => {
  it("issues a guest session with strict cookie attributes and a bound CSRF token", async () => {
    const { app } = await server();
    const client = new TestClient(app);
    const res = await client.request("GET", "/auth/me");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user: unknown;
      guest: { id: string };
      csrfToken: string;
      preferences: unknown;
    };
    expect(body.user).toBeNull();
    expect(body.guest.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.csrfToken.length).toBeGreaterThan(20);
    expect(body.preferences).toEqual({});
    const cookie = setCookieHeaders(res).find((c) => c.startsWith("gid="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/); // plain-HTTP loopback
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("registers with Argon2id + per-user salt, stores only token hashes, and never returns secrets", async () => {
    const { app, db } = await server();
    const alice = new TestClient(app);
    const res = await alice.register("Alice", PASSWORD, "Alice A.");
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as {
      user: { id: string; username: string; displayName: string };
      guest: unknown;
    };
    expect(body.user.username).toBe("alice");
    expect(body.user.displayName).toBe("Alice A.");
    expect(body.guest).toBeNull();
    const sid = alice.cookies.get("sid") as string;
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256-bit token
    const sidCookie = setCookieHeaders(res).find((c) => c.startsWith("sid="));
    expect(sidCookie).toMatch(/HttpOnly/);
    expect(sidCookie).toMatch(/SameSite=Strict/);
    for (const forbidden of [PASSWORD, sid, "argon2", "passwordHash", "password_hash", "tokenHash"]) {
      expect(res.body).not.toContain(forbidden);
    }

    const bob = new TestClient(app);
    expect((await bob.register("bob", PASSWORD)).statusCode).toBe(201);
    const rows = db.prepare("SELECT username_normalized, password_hash FROM users ORDER BY 1").all() as {
      username_normalized: string;
      password_hash: string;
    }[];
    for (const row of rows) {
      expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$pv=1,m=19456,t=2,p=1\$/);
      expect(row.password_hash).not.toContain(PASSWORD);
    }
    expect(rows[0]?.password_hash).not.toBe(rows[1]?.password_hash); // same password, different salt

    const sessions = db.prepare("SELECT token_hash FROM sessions WHERE kind = 'account'").all() as {
      token_hash: string;
    }[];
    expect(sessions.map((s) => s.token_hash)).toContain(createHash("sha256").update(sid).digest("hex"));
    const dump = JSON.stringify(db.prepare("SELECT * FROM sessions").all());
    expect(dump).not.toContain(sid);

    const me = await alice.request("GET", "/auth/me");
    const meBody = me.json() as { user: { username: string }; csrfToken: string };
    expect(meBody.user.username).toBe("alice");
    for (const forbidden of [sid, "argon2", "password"]) expect(me.body).not.toContain(forbidden);
  });

  it("logs out by revoking the session; the old cookie no longer authenticates", async () => {
    const { app, db } = await server();
    const alice = new TestClient(app);
    await alice.register("alice");
    const sid = alice.cookies.get("sid") as string;
    const out = await alice.request("POST", "/auth/logout");
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json()).toEqual({ ok: true, revokedSessions: 1 });
    expect(alice.cookies.has("sid")).toBe(false);
    const row = db
      .prepare("SELECT revoked_at FROM sessions WHERE token_hash = ?")
      .get(createHash("sha256").update(sid).digest("hex")) as { revoked_at: string | null };
    expect(row.revoked_at).not.toBeNull();

    const replay = new TestClient(app);
    replay.cookies.set("sid", sid);
    const me = (await replay.me()) as { user: unknown };
    expect(me.user).toBeNull();
  });

  it("generic login failures; old password fails and other sessions are revoked after a change", async () => {
    const { app } = await server();
    const alice = new TestClient(app);
    await alice.register("alice");
    const other = new TestClient(app);
    expect((await other.login("ALICE", PASSWORD)).statusCode).toBe(200); // case-insensitive username

    const wrong = expectEnvelope(
      await new TestClient(app).login("alice", "wrong password here"),
      401,
      "UNAUTHENTICATED",
    );
    const unknown = expectEnvelope(
      await new TestClient(app).login("nobody", PASSWORD),
      401,
      "UNAUTHENTICATED",
    );
    expect(wrong.error.message).toBe(unknown.error.message);

    const bad = await alice.request("POST", "/auth/password", {
      currentPassword: "not my password",
      newPassword: "brand new password",
    });
    expectEnvelope(bad, 400, "VALIDATION_ERROR");
    const change = await alice.request("POST", "/auth/password", {
      currentPassword: PASSWORD,
      newPassword: "brand new password",
    });
    expect(change.statusCode, change.body).toBe(200);
    expect(change.json()).toEqual({ ok: true, revokedSessions: 1 });

    expect(((await alice.request("GET", "/auth/me")).json() as { user: unknown }).user).not.toBeNull();
    expect(((await other.request("GET", "/auth/me")).json() as { user: unknown }).user).toBeNull();
    expectEnvelope(await new TestClient(app).login("alice", PASSWORD), 401, "UNAUTHENTICATED");
    expect((await new TestClient(app).login("alice", "brand new password")).statusCode).toBe(200);
  });

  it("clears every session of the account with logout allSessions", async () => {
    const { app } = await server();
    const a = new TestClient(app);
    await a.register("alice");
    const b = new TestClient(app);
    await b.login("alice", PASSWORD);
    const res = await a.request("POST", "/auth/logout", { allSessions: true });
    expect(res.json()).toEqual({ ok: true, revokedSessions: 2 });
    expect(((await b.request("GET", "/auth/me")).json() as { user: unknown }).user).toBeNull();
    expectEnvelope(await a.request("POST", "/auth/logout", { allSessions: "yes" }), 403, "FORBIDDEN"); // csrf now stale
  });

  it("expires sessions after the TTL", async () => {
    let now = new Date("2026-10-12T00:00:00.000Z");
    const { app } = await server({ clock: () => now });
    const alice = new TestClient(app);
    await alice.register("alice");
    now = new Date(now.getTime() + LIMITS.sessionTtlMs + 1000);
    const me = await alice.request("GET", "/auth/me");
    expect((me.json() as { user: unknown }).user).toBeNull();
  });

  it("rehashes a legacy-parameter hash on successful login", async () => {
    const legacyParams: PasswordParams = {
      version: 0,
      memoryKiB: 1024,
      passes: 1,
      parallelism: 1,
      tagLength: 32,
      saltLength: 16,
    };
    const first = await server({ hasher: new PasswordHasher(legacyParams) });
    await new TestClient(first.app).register("legacy");
    const before = (first.db.prepare("SELECT password_hash FROM users").get() as { password_hash: string })
      .password_hash;
    expect(before).toMatch(/\$pv=0,m=1024,t=1,p=1\$/);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await server({ dir: first.dir });
    expect((await new TestClient(second.app).login("legacy", PASSWORD)).statusCode).toBe(200);
    const after = (second.db.prepare("SELECT password_hash FROM users").get() as { password_hash: string })
      .password_hash;
    expect(after).toMatch(/\$pv=1,m=19456,t=2,p=1\$/);
    expect((await new TestClient(second.app).login("legacy", PASSWORD)).statusCode).toBe(200);
  });

  it("owner reset is a local CLI operation that revokes sessions (no HTTP route)", async () => {
    const s = await server();
    const alice = new TestClient(s.app);
    await alice.register("alice");
    const dbPath = s.dbPath;
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    await expect(ownerResetPassword(dbPath, "alice", "short")).rejects.toThrow();
    await expect(ownerResetPassword(dbPath, "nobody", "a valid new password")).rejects.toThrow(
      /No active account/,
    );
    expect(await ownerResetPassword(dbPath, "ALICE", "owner reset password")).toEqual({ revokedSessions: 1 });

    const again = await server({ dir: s.dir });
    expectEnvelope(await new TestClient(again.app).login("alice", PASSWORD), 401, "UNAUTHENTICATED");
    expect((await new TestClient(again.app).login("alice", "owner reset password")).statusCode).toBe(200);
    const probe = new TestClient(again.app);
    await probe.me();
    expectEnvelope(
      await probe.request("POST", "/auth/reset-password", { username: "alice" }),
      404,
      "NOT_FOUND",
    );
  });
});

describe("ACC-02 usernames, display names, password limits", () => {
  it("rejects duplicate case variants and invalid usernames", async () => {
    const { app } = await server();
    expect((await new TestClient(app).register("Alice")).statusCode).toBe(201);
    for (const variant of ["alice", "ALICE", "aLiCe"]) {
      const body = expectEnvelope(await new TestClient(app).register(variant), 400, "VALIDATION_ERROR");
      expect(body.error.details).toMatchObject({ field: "username" });
    }
    for (const bad of ["ab", "a".repeat(25), "bad-name", "with space", "ünïcode", "ALİCE", ""]) {
      expectEnvelope(await new TestClient(app).register(bad), 400, "VALIDATION_ERROR");
    }
    expect((await new TestClient(app).register("a".repeat(24))).statusCode).toBe(201);
    expect((await new TestClient(app).register("x_9")).statusCode).toBe(201);
  });

  it("display names are 1-48 code points of text, stored and returned verbatim", async () => {
    const { app } = await server();
    const emoji = "😀".repeat(48); // 48 code points, 96 UTF-16 units
    const res = await new TestClient(app).register("emoji", PASSWORD, emoji);
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { user: { displayName: string } }).user.displayName).toBe(emoji);
    const html = "<script>alert(1)</script>";
    const tag = await new TestClient(app).register("htmlname", PASSWORD, html);
    expect((tag.json() as { user: { displayName: string } }).user.displayName).toBe(html);
    for (const bad of ["", "😀".repeat(49), "bell\u0007", "   "]) {
      expectEnvelope(await new TestClient(app).register("someone", PASSWORD, bad), 400, "VALIDATION_ERROR");
    }
  });

  it("passwords are 12-128 code points", async () => {
    const { app } = await server();
    expectEnvelope(await new TestClient(app).register("short", "x".repeat(11)), 400, "VALIDATION_ERROR");
    expectEnvelope(await new TestClient(app).register("long", "x".repeat(129)), 400, "VALIDATION_ERROR");
    expect((await new TestClient(app).register("min", "x".repeat(12))).statusCode).toBe(201);
    const emojiPassword = "🔑".repeat(128);
    expect((await new TestClient(app).register("emojipw", emojiPassword)).statusCode).toBe(201);
    expect((await new TestClient(app).login("emojipw", emojiPassword)).statusCode).toBe(200);
  });
});

describe("ACC-03 guests and account separation", () => {
  it("a guest cannot act as an account", async () => {
    const { app } = await server();
    const guest = new TestClient(app);
    const me = (await guest.me()) as { user: unknown; guest: { id: string } };
    expect(me.user).toBeNull();
    expectEnvelope(
      await guest.request("POST", "/auth/password", {
        currentPassword: PASSWORD,
        newPassword: "another password",
      }),
      401,
      "UNAUTHENTICATED",
    );
    expectEnvelope(await guest.request("PATCH", "/profile", { displayName: "Sneaky" }), 403, "FORBIDDEN");
    const prefs = await guest.request("PATCH", "/profile", { preferences: { theme: "dark" } });
    expect(prefs.statusCode, prefs.body).toBe(200);
    expect(prefs.json()).toMatchObject({
      user: null,
      guest: { id: me.guest.id },
      preferences: { theme: "dark" },
    });

    // The guest token presented as an account cookie is not an account session.
    const forged = new TestClient(app);
    forged.cookies.set("sid", guest.cookies.get("gid") as string);
    const forgedMe = (await forged.me()) as { user: unknown };
    expect(forgedMe.user).toBeNull();
  });

  it("CSRF tokens are bound to one session; another account's token is useless", async () => {
    const { app } = await server();
    const alice = new TestClient(app);
    await alice.register("alice");
    const bob = new TestClient(app);
    await bob.register("bob");
    const stolen = alice.csrf;
    const res = await bob.request("PATCH", "/profile", { displayName: "Bobby" }, { "x-csrf-token": stolen });
    expectEnvelope(res, 403, "FORBIDDEN");
    const aliceMe = (await alice.me()) as { user: { username: string; displayName: string } };
    expect(aliceMe.user.username).toBe("alice");
    expect(JSON.stringify(aliceMe)).not.toContain("bob");
  });

  it("PATCH /profile accepts only allowlisted preferences", async () => {
    const { app } = await server();
    const alice = new TestClient(app);
    await alice.register("alice");
    const ok = await alice.request("PATCH", "/profile", {
      displayName: "Alice Liddell",
      preferences: {
        theme: "high-contrast",
        motion: "reduced",
        keyBindings: { up: ["w", "ArrowUp"], right: ["d"], down: ["s"], left: ["a"] },
      },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      user: { displayName: "Alice Liddell" },
      preferences: { theme: "high-contrast", motion: "reduced" },
    });
    const merged = await alice.request("PATCH", "/profile", { preferences: { soundMuted: true } });
    expect(merged.json()).toMatchObject({ preferences: { theme: "high-contrast", soundMuted: true } });
    expectEnvelope(
      await alice.request("PATCH", "/profile", { preferences: { evil: 1 } }),
      400,
      "VALIDATION_ERROR",
    );
    expectEnvelope(
      await alice.request("PATCH", "/profile", { preferences: { theme: "neon" } }),
      400,
      "VALIDATION_ERROR",
    );
    expectEnvelope(await alice.request("PATCH", "/profile", { isAdmin: true }), 400, "VALIDATION_ERROR");
  });
});

describe("ACC-04 Origin / Host / CSRF / rate limits", () => {
  it("rejects foreign origins, rebinding hosts, cross-site fetches, and missing CSRF", async () => {
    const { app } = await server();
    const client = new TestClient(app);
    await client.me();
    const body = { username: "alice", displayName: "Alice", password: PASSWORD };
    for (const origin of ["http://evil.example", "null", "http://127.0.0.1:9999", "https://127.0.0.1:5591"]) {
      expectEnvelope(await client.request("POST", "/auth/register", body, { origin }), 403, "FORBIDDEN");
    }
    client.origin = null;
    expectEnvelope(
      await client.request("POST", "/auth/register", body, { host: "evil.example" }),
      403,
      "FORBIDDEN",
    );
    expectEnvelope(
      await client.request("POST", "/auth/register", body, { host: "localhost:1234" }),
      403,
      "FORBIDDEN",
    );
    expectEnvelope(
      await client.request("POST", "/auth/register", body, { "sec-fetch-site": "cross-site" }),
      403,
      "FORBIDDEN",
    );
    expectEnvelope(
      await client.request("POST", "/auth/register", body, { "x-csrf-token": "forged" }),
      403,
      "FORBIDDEN",
    );
    const csrf = client.csrf;
    client.csrf = "";
    expectEnvelope(await client.request("POST", "/auth/register", body), 403, "FORBIDDEN");
    client.csrf = csrf;
    // Same Host without Origin (non-browser local client) is allowed.
    expect((await client.request("POST", "/auth/register", body)).statusCode).toBe(201);

    const anonymous = new TestClient(app);
    expectEnvelope(
      await anonymous.request("POST", "/auth/login", { username: "alice", password: PASSWORD }),
      403,
      "FORBIDDEN",
    );
    expect(TEST_HOST).toBe("127.0.0.1:5591");
  });

  it("limits failed logins per account with RATE_LIMITED 429, then recovers after the window", async () => {
    let now = new Date("2026-10-12T00:00:00.000Z");
    const { app } = await server({ clock: () => now });
    await new TestClient(app).register("alice");
    const attacker = new TestClient(app);
    for (let i = 0; i < LIMITS.loginAttemptsPerWindow; i += 1) {
      expectEnvelope(await attacker.login("alice", `wrong password ${i}`), 401, "UNAUTHENTICATED");
    }
    const limited = await attacker.login("alice", PASSWORD);
    const body = expectEnvelope(limited, 429, "RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(body.error.details).toMatchObject({ retryAfterSeconds: expect.any(Number) });
    now = new Date(now.getTime() + LIMITS.loginWindowMs + 1);
    expect((await attacker.login("alice", PASSWORD)).statusCode).toBe(200);
  });

  it("bounds username spraying from one client", async () => {
    const { app } = await server();
    const sprayer = new TestClient(app);
    let limited = false;
    for (let i = 0; i < LIMITS.loginAttemptsPerWindow * 4 + 1; i += 1) {
      const res = await sprayer.login(`user_${i}`, PASSWORD);
      if (res.statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe("error envelope, health, logging", () => {
  it("returns a generic INTERNAL_ERROR without stack, SQL, or paths", async () => {
    const { app } = await server({
      configure: (a) =>
        a.get(`${API_BASE}/__boom`, async () => {
          throw new Error("SELECT secret FROM sqlite_master /secret/path.ts:12");
        }),
    });
    const res = await new TestClient(app).request("GET", "/__boom");
    const body = expectEnvelope(res, 500, "INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
    expect(res.body).not.toContain("secret");
  });

  it("maps errors without leaking internals", async () => {
    const { app } = await server();
    const client = new TestClient(app);
    await client.me();
    expectEnvelope(await client.request("GET", "/does-not-exist"), 404, "NOT_FOUND");
    const malformed = await app.inject({
      method: "POST",
      url: `${API_BASE}/auth/login`,
      headers: {
        host: TEST_HOST,
        origin: `http://${TEST_HOST}`,
        "content-type": "application/json",
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "x-csrf-token": client.csrf,
      },
      payload: "{not json",
    });
    expectEnvelope(malformed, 400, "VALIDATION_ERROR");
    const big = await client.request("POST", "/auth/login", {
      username: "a",
      password: "x".repeat(LIMITS.requestBodyBytes),
    });
    expectEnvelope(big, 400, "VALIDATION_ERROR");
    const invalid = expectEnvelope(
      await client.request("POST", "/auth/register", { username: 5 }),
      400,
      "VALIDATION_ERROR",
    );
    expect(JSON.stringify(invalid.error.details)).toContain("username");
  });

  it("hides internal error details and reports DB_BUSY when the writer queue is full", async () => {
    const busy = await server({ writerQueueMax: 0 });
    const res = await new TestClient(busy.app).request("GET", "/auth/me");
    expectEnvelope(res, 503, "DB_BUSY");
    expect(res.headers["retry-after"]).toBe("1");
  });

  it("reports health and readiness", async () => {
    const { app } = await server();
    const client = new TestClient(app);
    expect((await client.request("GET", "/health")).json()).toEqual({ status: "ok" });
    expect((await client.request("GET", "/ready")).json()).toMatchObject({ status: "ready", migrations: 1 });
  });

  it("structured logs redact cookies, tokens and passwords", async () => {
    const lines: string[] = [];
    const { app } = await server({
      logger: { stream: { write: (line: string) => lines.push(line) }, level: "trace" },
    });
    const alice = new TestClient(app);
    await alice.register("alice");
    await alice.request("POST", "/auth/logout");
    await new TestClient(app).login("alice", "wrong password value");
    await alice.login("alice", PASSWORD);
    const sid = alice.cookies.get("sid") as string;
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(4);
    for (const secret of [PASSWORD, "wrong password value", sid, alice.csrf, "argon2"]) {
      expect(text).not.toContain(secret);
    }
  });
});
