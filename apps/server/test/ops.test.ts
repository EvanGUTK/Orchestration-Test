import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, trustedHosts } from "../src/config.ts";
import { Client, HOST_HEADER, startApp } from "./helpers.ts";

describe("config", () => {
  it("only binds loopback addresses and defaults to 127.0.0.1", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "::1" }).host).toBe("::1");
    for (const bad of ["0.0.0.0", "::", "192.168.1.5", "localhost", "example.com"]) {
      expect(() => loadConfig({ HOST: bad }), bad).toThrow(/loopback/);
    }
  });

  it("reads ports and database path from the environment and validates numbers", () => {
    const c = loadConfig({ API_PORT: "5511", WEB_PORT: "5411", DATABASE_PATH: "/tmp/x/game.sqlite3" });
    expect(c).toMatchObject({ port: 5511, webPort: 5411, databasePath: "/tmp/x/game.sqlite3" });
    expect(() => loadConfig({ API_PORT: "99999" })).toThrow(/API_PORT/);
    expect(() => loadConfig({ API_PORT: "12abc" })).toThrow(/API_PORT/);
    expect([...trustedHosts(c)].sort()).toContain("127.0.0.1:5511");
    expect(trustedHosts(c).has("0.0.0.0:5511")).toBe(false);
  });
});

describe("static web client", { timeout: 30_000 }, () => {
  it("serves apps/web/dist when present, with SPA fallback and without shadowing the API", async () => {
    const dist = mkdtempSync(join(tmpdir(), "2048-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>2048</title><div id=root></div>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    const t = await startApp({ WEB_DIST: dist });
    const get = (url: string, accept = "text/html") => t.app.inject({ method: "GET", url, headers: { host: HOST_HEADER, accept } });

    const root = await get("/");
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("<title>2048</title>");
    const csp = String(root.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:*");
    expect(csp).not.toContain("[::1]"); // Chrome rejects bracketed IPv6 sources
    const js = await get("/assets/app.js", "*/*");
    expect(js.statusCode).toBe(200);
    expect(js.body).toBe("console.log(1)");
    const deep = await get("/play/some-game");
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("<title>2048</title>");
    const api404 = await get("/api/v1/does-not-exist");
    expect(api404.statusCode).toBe(404);
    expect(JSON.parse(api404.body).error.code).toBe("NOT_FOUND");
    expect((await get("/api/v1/health", "*/*")).statusCode).toBe(200);
    const traversal = await get("/%2e%2e/%2e%2e/etc/passwd", "*/*");
    expect(traversal.statusCode).not.toBe(200);
    expect(traversal.body).not.toContain("root:");
  });

  it("still boots (API only) when apps/web/dist does not exist", async () => {
    const t = await startApp({ WEB_DIST: "/nonexistent/dist" });
    const r = await t.app.inject({ method: "GET", url: "/", headers: { host: HOST_HEADER, accept: "text/html" } });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error.code).toBe("NOT_FOUND");
  });
});

describe("backpressure", { timeout: 30_000 }, () => {
  it("returns DB_BUSY (503) when the bounded write queue is full, and loses no accepted write", async () => {
    const t = await startApp({ WRITE_QUEUE_MAX: "2" });
    const clients = Array.from({ length: 12 }, () => new Client(t.app));
    const results = await Promise.all(clients.map((c) => c.post("/auth/guest")));
    const ok = results.filter((r) => r.status === 201);
    const busy = results.filter((r) => r.status === 503);
    expect(ok.length + busy.length).toBe(12);
    expect(busy.length).toBeGreaterThan(0);
    for (const r of busy) {
      expect(r.body.error.code).toBe("DB_BUSY");
      expect(r.headers["retry-after"]).toBe("1");
    }
    expect(t.db.raw.prepare("SELECT count(*) AS n FROM guests").get()).toEqual({ n: ok.length });
    expect(t.db.integrityCheck()).toEqual(["ok"]);
    // health stays responsive and the queue drains
    expect((await new Client(t.app).get("/health")).status).toBe(200);
    expect((await new Client(t.app).post("/auth/guest")).status).toBe(201);
  });
});
