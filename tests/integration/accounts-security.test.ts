/**
 * ACC-01..05 against the production server entry on loopback with a private temp DB.
 * Expected behaviour comes from docs/ACCEPTANCE.md + docs/CONTRACTS.md; database facts are read from the file with a
 * second read-only connection. Skipped loudly if the server is absent.
 */
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, newCommandId, type Dir } from "../acceptance/support/client.ts";
import { serverAvailable, startServer, type ServerHandle } from "../acceptance/support/server-process.ts";
import { dumpAllText, sha256, withDb } from "./support/db.ts";
import { OracleGame, practiceRules, unwrapGame } from "./support/game-driver.ts";
import type { OState } from "./oracle/game.ts";

const available = serverAvailable();
if (!available) console.warn("accounts-security SKIPPED: server missing (not a pass)");
const PW = "correct horse battery staple 9";
const uniq = (p = "u") => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toLowerCase();
type Err = { error: { code: string; message: string; requestId: string } };
type Identity = { kind: string; userId: string; username?: string; displayName: string; csrfToken: string };
type GameLite = { id: string; state: OState };

function rawRequest(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) {
  const u = new URL(base);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((res, rej) => {
    const r = httpRequest({ host: u.hostname, port: u.port, path, method: opts.method ?? "GET", headers: opts.headers }, (m) => {
      let b = "";
      m.on("data", (d) => (b += d));
      m.on("end", () => res({ status: m.statusCode ?? 0, headers: m.headers, body: b }));
    });
    r.on("error", rej);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

describe.skipIf(!available)("accounts and request security", () => {
  let server: ServerHandle;
  beforeAll(async () => {
    server = await startServer({ timeoutMs: 60_000 });
  });
  afterAll(async () => {
    await server?.stop();
  });
  const fresh = () => new ApiClient(server.baseUrl);

  describe("ACC-01 credentials and sessions", () => {
    it("register issues an identity + HttpOnly SameSite=Strict session cookie and leaks no hash/token material", async () => {
      const c = fresh();
      const name = uniq("acc1");
      const r = await c.post<Identity>("/auth/register", { username: name, displayName: "Alice", password: PW });
      expect(r.status, r.raw).toBe(201);
      expect(r.body.kind).toBe("user");
      expect(typeof r.body.csrfToken).toBe("string");
      expect(r.raw).not.toMatch(/argon|hash|\$argon2|password/i);
      const sc = r.headers.getSetCookie().join("\n");
      expect(sc).toMatch(/sid=/);
      expect(sc).toMatch(/HttpOnly/i);
      expect(sc).toMatch(/SameSite=Strict/i);
      const me = await c.get<Identity>("/auth/me");
      expect(me.status).toBe(200);
      expect(me.body.username).toBe(name);
      expect(me.raw).not.toMatch(/argon|hash|\$argon2|token_hash/i);
    });

    it("password is stored only as a salted Argon2id hash; session token is stored only hashed", async () => {
      const a = fresh(), b = fresh();
      const na = uniq("saltA"), nb = uniq("saltB");
      await a.registerAndLogin(na, PW);
      await b.registerAndLogin(nb, PW);
      const cookie = a.cookieHeader().replace(/^sid=/, "").split(";")[0]!;
      withDb(server.dbPath, (db) => {
        const rows = db.prepare("SELECT username_normalized AS u, password_hash AS h FROM users WHERE username_normalized IN (?, ?)").all(na, nb) as { u: string; h: string }[];
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(r.h).toMatch(/^\$argon2id\$/);
        expect(rows[0]!.h).not.toBe(rows[1]!.h); // same password, different salt
        expect(rows.map((r) => r.h).join("")).not.toContain(PW);
      });
      const all = dumpAllText(server.dbPath);
      expect(all).not.toContain(cookie);
      expect(all).not.toContain(PW);
      withDb(server.dbPath, (db) => {
        const n = db.prepare("SELECT count(*) AS n FROM sessions WHERE token_hash = ?").get(sha256(cookie)) as { n: number };
        // acceptable if the hash scheme is sha256(token); if another scheme is used the raw-token scan above is the guard
        expect([0, 1]).toContain(n.n);
      });
    });

    it("logout revokes the session: replaying the old cookie is 401; login again works", async () => {
      const c = fresh();
      const name = uniq("out");
      await c.registerAndLogin(name, PW);
      const stolen = c.clone();
      expect((await c.post("/auth/logout")).status).toBe(200);
      expect((await stolen.get("/auth/me")).status, "replayed cookie after logout").toBe(401);
      expect((await c.get("/auth/me")).status).toBe(401);
      const again = fresh();
      expect((await again.post("/auth/login", { username: name, password: PW })).status).toBe(200);
    });

    it("password change: old password fails, new works, other sessions revoked (also in DB), current survives", async () => {
      const name = uniq("chg");
      const a = fresh();
      await a.registerAndLogin(name, PW);
      const b = fresh();
      const lb = await b.post<Identity>("/auth/login", { username: name, password: PW });
      b.csrfToken = lb.body.csrfToken;
      const NEW = "a brand new passphrase 77";
      expect((await a.post("/auth/password", { oldPassword: "wrong wrong wrong", newPassword: NEW })).status).toBeGreaterThanOrEqual(400);
      expect((await a.post("/auth/password", { oldPassword: PW, newPassword: NEW })).status).toBe(200);
      expect((await b.get("/auth/me")).status).toBe(401);
      expect((await a.get("/auth/me")).status).toBe(200);
      expect((await fresh().post("/auth/login", { username: name, password: PW })).status).toBe(401);
      expect((await fresh().post("/auth/login", { username: name, password: NEW })).status).toBe(200);
      withDb(server.dbPath, (db) => {
        const u = db.prepare("SELECT id FROM users WHERE username_normalized = ?").get(name) as { id: string };
        const rev = db.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NOT NULL").get(u.id) as { n: number };
        expect(rev.n).toBeGreaterThanOrEqual(1);
      });
    });

    it("wrong-username and wrong-password logins are indistinguishable (no user enumeration)", async () => {
      const name = uniq("enum");
      await fresh().registerAndLogin(name, PW);
      const a = await fresh().post<Err>("/auth/login", { username: name, password: "not the password 1" });
      const b = await fresh().post<Err>("/auth/login", { username: uniq("ghost"), password: "not the password 1" });
      expect(a.status).toBe(b.status);
      expect(a.body.error.code).toBe(b.body.error.code);
      expect(a.body.error.message).toBe(b.body.error.message);
    });
  });

  describe("ACC-02 username normalization and input limits", () => {
    it("case, surrounding whitespace and compatibility forms (fullwidth) are duplicates", async () => {
      const base = uniq("norm").toLowerCase();
      expect((await fresh().post("/auth/register", { username: base, displayName: "n", password: PW })).status).toBe(201);
      const variants = [base.toUpperCase(), ` ${base} `, base.replace(/[a-z]/g, (ch) => String.fromCodePoint(ch.charCodeAt(0) - 97 + 0xff41))];
      for (const v of variants) {
        const r = await fresh().post<Err>("/auth/register", { username: v, displayName: "n", password: PW });
        expect([400, 409], `variant ${JSON.stringify(v)} => ${r.status} ${r.raw}`).toContain(r.status);
      }
      // and login is normalized the same way
      expect((await fresh().post("/auth/login", { username: base.toUpperCase(), password: PW })).status).toBe(200);
    });
    it("rejects bad usernames, passwords, display names and unknown fields with VALIDATION_ERROR (400)", async () => {
      const good = { username: uniq("v"), displayName: "ok", password: PW };
      const cases: [string, Record<string, unknown>][] = [
        ["username 2 chars", { ...good, username: "ab" }],
        ["username 33 chars", { ...good, username: "a".repeat(33) }],
        ["username with space/symbol", { ...good, username: "bad name!" }],
        ["username 10k", { ...good, username: "a".repeat(10_000) }],
        ["password 7", { ...good, password: "1234567" }],
        ["password 129", { ...good, password: "p".repeat(129) }],
        ["displayName angle brackets", { ...good, displayName: "<img src=x onerror=alert(1)>" }],
        ["displayName control char", { ...good, displayName: "a\u0007b" }],
        ["displayName empty", { ...good, displayName: "   " }],
        ["displayName 33 chars", { ...good, displayName: "d".repeat(33) }],
        ["unknown field (mass assignment)", { ...good, isAdmin: true }],
        ["non-string password", { ...good, password: 12345678 }],
      ];
      for (const [name, body] of cases) {
        const r = await fresh().post<Err>("/auth/register", body);
        expect(r.status, `${name}: ${r.raw}`).toBe(400);
        expect(r.body.error.code, name).toBe("VALIDATION_ERROR");
      }
    });
    it("accepts unicode display names (emoji, accents) and returns them as plain text", async () => {
      const c = fresh();
      const r = await c.post<Identity>("/auth/register", { username: uniq("uni"), displayName: "Zoë 🎮 日本", password: PW });
      expect(r.status, r.raw).toBe(201);
      expect(r.body.displayName).toBe("Zoë 🎮 日本");
      expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    });
  });

  describe("ACC-03 isolation between two accounts and a guest", () => {
    it("account B and a guest cannot read or change account A's games (404, never leaking existence)", async () => {
      const a = fresh(), b = fresh(), g = fresh();
      await a.registerAndLogin(uniq("isoA"), PW);
      await b.registerAndLogin(uniq("isoB"), PW);
      const gi = await g.post<Identity>("/auth/guest");
      expect(gi.status, gi.raw).toBeLessThan(300);
      g.csrfToken = gi.body.csrfToken;
      const made = await a.post("/games", { mode: "classic" });
      expect(made.status, made.raw).toBe(201);
      const game = unwrapGame<GameLite>(made.body);
      const mv = { commandId: newCommandId(), expectedRevision: 0, direction: "left" as Dir };
      for (const intruder of [b, g]) {
        expect((await intruder.get(`/games/${game.id}`)).status).toBe(404);
        expect((await intruder.get(`/games/${game.id}/events`)).status).toBe(404);
        expect((await intruder.post(`/games/${game.id}/moves`, mv)).status).toBe(404);
        expect((await intruder.post(`/games/${game.id}/undo`, { commandId: newCommandId(), expectedRevision: 0 })).status).toBe(404);
        expect((await intruder.post(`/games/${game.id}/forfeit`, { commandId: newCommandId(), expectedRevision: 0 })).status).toBe(404);
        const list = await intruder.get<{ items: { id: string }[] }>("/games?status=all");
        expect(list.status).toBe(200);
        expect(list.body.items.map((i) => i.id)).not.toContain(game.id);
      }
      const nonexistent = await b.get<Err>("/games/00000000-0000-4000-8000-000000000000");
      const foreign = await b.get<Err>(`/games/${game.id}`);
      expect(foreign.status).toBe(nonexistent.status); // indistinguishable
      expect(foreign.body.error.code).toBe(nonexistent.body.error.code);
      // owner is untouched
      const still = unwrapGame<GameLite>((await a.get(`/games/${game.id}`)).body);
      expect(still.state.revision).toBe(0);
    });
    it("a guest can play casual games but cannot use account-only actions", async () => {
      const g = fresh();
      const gi = await g.post<Identity>("/auth/guest");
      g.csrfToken = gi.body.csrfToken;
      expect(gi.body.kind).toBe("guest");
      const made = await g.post("/games", { mode: "classic" });
      expect(made.status, made.raw).toBe(201);
      const game = unwrapGame<GameLite>(made.body);
      const o = new OracleGame(practiceRules(4), "unused");
      void o;
      const r = await g.post<{ game: GameLite }>(`/games/${game.id}/moves`, { commandId: newCommandId(), expectedRevision: 0, direction: "left" });
      expect(r.status, r.raw).toBe(200);
      expect((await g.post("/auth/password", { oldPassword: PW, newPassword: "another passphrase 1" })).status).toBe(403);
      expect((await g.request("PATCH", "/profile", { displayName: "x" })).status).toBe(403);
      expect((await g.request("DELETE", "/profile", { password: PW })).status).toBe(403);
      // guest rows are separate from user rows
      withDb(server.dbPath, (db) => {
        const n = db.prepare("SELECT count(*) AS n FROM games WHERE id = ? AND owner_guest_id IS NOT NULL AND owner_user_id IS NULL").get(game.id) as { n: number };
        expect(n.n).toBe(1);
      });
    });
    it("a guest cannot create ranked/duel games through POST /games", async () => {
      const g = fresh();
      const gi = await g.post<Identity>("/auth/guest");
      g.csrfToken = gi.body.csrfToken;
      for (const mode of ["ranked", "duel", "bot-league"]) {
        const r = await g.post<Err>("/games", { mode });
        expect(r.status, `${mode}: ${r.raw}`).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
      }
    });
  });

  describe("ACC-04 CSRF, Origin, Host, rate limits, body limits", () => {
    it("missing or wrong CSRF token on a mutating call is 403 and changes nothing", async () => {
      const c = fresh();
      await c.registerAndLogin(uniq("csrf"), PW);
      const game = unwrapGame<GameLite>((await c.post("/games", { mode: "classic" })).body);
      const body = { commandId: newCommandId(), expectedRevision: 0, direction: "left" };
      for (const tok of [undefined, "", "deadbeef", "x".repeat(300)]) {
        const bad = c.clone();
        bad.csrfToken = null;
        const r = await bad.request<Err>("POST", `/games/${game.id}/moves`, body, tok === undefined ? {} : { "x-csrf-token": tok });
        expect(r.status, `token ${JSON.stringify(tok)}`).toBe(403);
      }
      expect(unwrapGame<GameLite>((await c.get(`/games/${game.id}`)).body).state.revision).toBe(0);
      // another user's valid token must not work for this session
      const other = fresh();
      await other.registerAndLogin(uniq("csrf2"), PW);
      const cross = c.clone();
      cross.csrfToken = other.csrfToken;
      expect((await cross.post(`/games/${game.id}/moves`, body)).status).toBe(403);
    });
    it("foreign Origin, 'null' Origin and cross-site fetch metadata are rejected; same-origin works", async () => {
      const c = fresh();
      await c.registerAndLogin(uniq("orig"), PW);
      for (const origin of ["http://evil.example", "null", `http://127.0.0.1.evil.example:${server.port}`, `https://127.0.0.1:${server.port}`]) {
        const r = await c.post<Err>("/games", { mode: "classic" }, { origin });
        expect(r.status, origin).toBe(403);
      }
      const noOrigin = await rawRequest(server.baseUrl, "/api/v1/games", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", cookie: c.cookieHeader(), "x-csrf-token": c.csrfToken ?? "" },
        body: "{\"mode\":\"classic\"}",
      });
      expect(noOrigin.status).toBe(403);
      expect((await c.post("/games", { mode: "classic" })).status).toBe(201);
    });
    it("untrusted Host header (DNS rebinding) is rejected for reads and writes", async () => {
      for (const host of ["evil.example", `evil.example:${server.port}`, "127.0.0.1.evil.example"]) {
        const r = await rawRequest(server.baseUrl, "/api/v1/health", { headers: { host } });
        expect(r.status, host).toBe(403);
      }
      expect((await rawRequest(server.baseUrl, "/api/v1/health", { headers: { host: `127.0.0.1:${server.port}` } })).status).toBe(200);
    });
    it("no permissive CORS: foreign origins get no Access-Control-Allow-Origin, including on preflight", async () => {
      const r = await rawRequest(server.baseUrl, "/api/v1/health", { headers: { origin: "http://evil.example" } });
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      const p = await rawRequest(server.baseUrl, "/api/v1/games", {
        method: "OPTIONS",
        headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
      });
      expect(p.headers["access-control-allow-origin"]).toBeUndefined();
    });
    it("login failures are bounded per account: 429 with Retry-After, not 500", async () => {
      const name = uniq("brute");
      await fresh().registerAndLogin(name, PW);
      const seen: number[] = [];
      let retryAfter: string | null = null;
      for (let i = 0; i < 30; i++) {
        const r = await fresh().post<Err>("/auth/login", { username: name, password: `wrong password ${i}` });
        seen.push(r.status);
        if (r.status === 429) retryAfter ??= r.headers.get("retry-after");
        expect(r.status).toBeLessThan(500);
      }
      expect(seen).toContain(429);
      expect(retryAfter).not.toBeNull();
    });
    it("oversize body, malformed JSON and wrong content type are 4xx VALIDATION_ERROR envelopes, never 500, and /health stays up", async () => {
      const c = fresh();
      await c.registerAndLogin(uniq("body"), PW);
      const big = await c.request<Err>("POST", "/games", JSON.stringify({ mode: "classic", pad: "x".repeat(2 * 1024 * 1024) }), { "content-type": "application/json" });
      expect([400, 413]).toContain(big.status);
      expect(big.body.error?.code).toBe("VALIDATION_ERROR");
      const bad = await c.request<Err>("POST", "/games", "{oops", { "content-type": "application/json" });
      expect(bad.status).toBe(400);
      const ct = await c.request<Err>("POST", "/games", "mode=classic", { "content-type": "application/x-www-form-urlencoded" });
      expect([400, 415]).toContain(ct.status);
      expect(ct.body.error?.code).toBe("VALIDATION_ERROR");
      for (const r of [big, bad, ct]) expect(r.raw).not.toMatch(/\n\s+at |node_modules|\.ts:\d+/);
      expect((await fresh().get("/health")).status).toBe(200);
    });
    it("security headers: nosniff, no-store on API, no server version banner leak", async () => {
      const r = await fresh().get("/health");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("cache-control")).toMatch(/no-store/);
      expect(r.headers.get("x-powered-by")).toBeNull();
    });
  });

  describe("ACC-05 export and delete profile", () => {
    it("GET /profile/export returns the owner's data without credential or session material", async () => {
      const c = fresh();
      const name = uniq("exp");
      await c.registerAndLogin(name, PW);
      await c.post("/games", { mode: "classic" });
      const r = await c.get<Record<string, unknown>>("/profile/export");
      expect(r.status, r.raw).toBe(200);
      expect(r.raw).toContain(name);
      expect(r.raw).not.toMatch(/argon2|password_hash|passwordHash|token_hash|tokenHash|csrf/i);
      expect(r.raw).not.toContain(PW);
      expect((await fresh().get("/profile/export")).status).toBe(401);
    });
    it("DELETE /profile needs the current password; wrong password changes nothing", async () => {
      const c = fresh();
      const name = uniq("delw");
      await c.registerAndLogin(name, PW);
      const r = await c.request<Err>("DELETE", "/profile", { password: "definitely not it 1" });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect((await c.get("/auth/me")).status).toBe(200);
      expect((await fresh().post("/auth/login", { username: name, password: PW })).status).toBe(200);
    });
    it("delete removes credentials and personal data everywhere in the database, revokes sessions, blocks login", async () => {
      const c = fresh();
      const name = uniq("delme");
      const display = `Dana${Math.random().toString(36).slice(2, 8)}`;
      const reg = await c.post<Identity>("/auth/register", { username: name, displayName: display, password: PW });
      c.csrfToken = reg.body.csrfToken;
      const other = c.clone();
      const game = unwrapGame<GameLite>((await c.post("/games", { mode: "classic" })).body);
      expect((await c.post(`/games/${game.id}/moves`, { commandId: newCommandId(), expectedRevision: 0, direction: "left" })).status).toBe(200);
      const hashBefore = withDb(server.dbPath, (db) => (db.prepare("SELECT password_hash AS h FROM users WHERE username_normalized = ?").get(name) as { h: string }).h);
      expect(hashBefore).toMatch(/^\$argon2id\$/);
      const del = await c.request("DELETE", "/profile", { password: PW });
      expect(del.status, del.raw).toBe(200);
      expect((await c.get("/auth/me")).status).toBe(401);
      expect((await other.get("/auth/me")).status, "other session of the deleted account").toBe(401);
      expect((await fresh().post("/auth/login", { username: name, password: PW })).status).toBe(401);
      const dump = dumpAllText(server.dbPath);
      expect(dump, "argon2 hash must be gone").not.toContain(hashBefore);
      expect(dump, "username must be gone or anonymized").not.toContain(`"${name}"`);
      expect(dump, "display name must be gone or anonymized").not.toContain(display);
      withDb(server.dbPath, (db) => {
        const live = db.prepare("SELECT count(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.deleted_at IS NOT NULL AND s.revoked_at IS NULL").get() as { n: number };
        expect(live.n).toBe(0);
      });
    });
  });
});
