/**
 * HTTP contract + account acceptance over the production server on loopback:
 * ACC-01 (register/login/me/logout/password change), ACC-02 (normalization/limits), ACC-04 (foreign Origin, loopback-only bind),
 * error envelope (docs/CONTRACTS.md). Pure API checks driven by the shared ApiClient.
 */
import { networkInterfaces } from "node:os";
import { expect, test } from "@playwright/test";
import { ApiClient } from "./support/client.ts";

type Err = { error: { code: string; message: string; requestId: string } };
const unique = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe("api contract", () => {
  test("health and ready are unauthenticated and leak no secrets", async ({ baseURL }) => {
    const c = new ApiClient(baseURL!);
    const h = await c.get<{ status: string }>("/health");
    expect(h.status).toBe(200);
    expect(h.body.status).toBe("ok");
    const r = await c.get<{ status: string }>("/ready");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ready");
    expect(h.raw + r.raw).not.toMatch(/password|token|secret|sqlite|\/Users\//i);
  });

  test("errors use the documented envelope and never include stack traces", async ({ baseURL }) => {
    const c = new ApiClient(baseURL!);
    const nf = await c.get<Err>("/definitely-not-a-route");
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("NOT_FOUND");
    expect(typeof nf.body.error.requestId).toBe("string");
    const unauth = await c.get<Err>("/auth/me");
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe("UNAUTHENTICATED");
    const bad = await c.request<Err>("POST", "/auth/login", "{not json", { "content-type": "application/json" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    for (const r of [nf, unauth, bad]) expect(r.raw).not.toMatch(/\n\s+at |node_modules|\.ts:\d+/);
  });

  test("ACC-01: register, me, logout, login, change password revokes other sessions and old credential", async ({ baseURL }) => {
    const name = unique();
    const pw1 = "correct horse battery staple 9";
    const pw2 = "another long passphrase 42!";
    const a = new ApiClient(baseURL!);
    const reg = await a.registerAndLogin(name, pw1);
    expect(reg.status, reg.raw).toBeLessThan(300);
    const me = await a.get<{ username?: string; kind: string }>("/auth/me");
    expect(me.status).toBe(200);
    expect(me.raw).not.toMatch(/hash|argon|\$argon2|passwordHash|tokenHash/i);

    const b = new ApiClient(baseURL!); // second session
    const log = await b.post<{ csrfToken?: string }>("/auth/login", { username: name, password: pw1 });
    expect(log.status, log.raw).toBeLessThan(300);
    b.csrfToken = log.body.csrfToken ?? null;
    expect((await b.get("/auth/me")).status).toBe(200);

    const chg = await a.post("/auth/password", { oldPassword: pw1, newPassword: pw2 });
    expect(chg.status, chg.raw).toBeLessThan(300);
    expect((await b.get("/auth/me")).status, "other sessions are revoked").toBe(401);
    expect((await a.get("/auth/me")).status, "current session survives").toBe(200);
    expect((await new ApiClient(baseURL!).post("/auth/login", { username: name, password: pw1 })).status, "old password fails").toBeGreaterThanOrEqual(400);
    expect((await new ApiClient(baseURL!).post("/auth/login", { username: name, password: pw2 })).status).toBeLessThan(300);

    const out = await a.post("/auth/logout");
    expect(out.status).toBeLessThan(300);
    expect((await a.get("/auth/me")).status).toBe(401);
  });

  test("ACC-02: case variants of a username are duplicates; oversize/invalid input rejected", async ({ baseURL }) => {
    const name = `Case${unique()}`;
    const c1 = new ApiClient(baseURL!);
    expect((await c1.registerAndLogin(name)).status).toBeLessThan(300);
    const dup = await new ApiClient(baseURL!).post<Err>("/auth/register", { username: name.toUpperCase(), displayName: "x", password: "correct horse battery staple 9" });
    expect([400, 409]).toContain(dup.status);
    const dup2 = await new ApiClient(baseURL!).post<Err>("/auth/register", { username: name.toLowerCase(), displayName: "x", password: "correct horse battery staple 9" });
    expect([400, 409]).toContain(dup2.status);
    const long = await new ApiClient(baseURL!).post<Err>("/auth/register", { username: "a".repeat(10_000), displayName: "x", password: "correct horse battery staple 9" });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe("VALIDATION_ERROR");
    const evil = new ApiClient(baseURL!);
    const html = await evil.registerAndLogin(unique(), "correct horse battery staple 9", "<img src=x onerror=alert(1)>");
    if (html.status < 300) {
      // Stored literally is acceptable only if the API can never be rendered as HTML.
      expect(html.headers.get("content-type")).toMatch(/^application\/json/);
      expect(html.headers.get("x-content-type-options")?.toLowerCase()).toBe("nosniff");
    } else {
      expect(html.status).toBe(400);
    }
  });

  test("ACC-04: mutating request with a foreign Origin is rejected", async ({ baseURL }) => {
    const c = new ApiClient(baseURL!);
    const reg = await c.post<Err>("/auth/register", { username: unique(), displayName: "x", password: "correct horse battery staple 9" }, { origin: "http://evil.example" });
    expect(reg.status, reg.raw).toBe(403);
    const log = await c.post<Err>("/auth/login", { username: "nobody", password: "whatever whatever 1" }, { origin: "http://evil.example" });
    expect(log.status, log.raw).toBe(403);
  });

  test("ACC-04: login attempts are rate limited and bounded", async ({ baseURL }) => {
    const name = unique();
    const c = new ApiClient(baseURL!);
    expect((await c.registerAndLogin(name)).status).toBeLessThan(300);
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await new ApiClient(baseURL!).post("/auth/login", { username: name, password: `wrong-password-${i}` })).status);
    expect(statuses, "bounded login attempts").toContain(429);
    expect(statuses.every((s) => s === 401 || s === 429 || s === 400)).toBe(true);
  });

  test("server is bound to loopback only, not to LAN interfaces", async ({ baseURL }) => {
    const port = new URL(baseURL!).port;
    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i!.address);
    test.skip(lan.length === 0, "no non-loopback IPv4 interface on this host");
    for (const addr of lan) {
      const err = await fetch(`http://${addr}:${port}/api/v1/health`, { signal: AbortSignal.timeout(3000) }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err, `${addr}:${port} must refuse connections`).not.toBeNull();
    }
  });
});
