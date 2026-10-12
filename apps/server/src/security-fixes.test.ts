import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@g2048/contracts";
import { acquireDatabaseLock } from "@g2048/database";
import { CONTENT_SECURITY_POLICY } from "./http/security-hooks.js";
import { ownerResetPassword } from "./owner-reset.js";
import { PasswordHasher, type PasswordParams } from "./security/passwords.js";
import { removeDir, startTestServer, TestClient, type TestServer } from "./test-support.js";

const PASSWORD = "correct horse battery";
const servers: TestServer[] = [];
const dirs = new Set<string>();

async function server(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(options);
  servers.push(s);
  dirs.add(s.dir);
  return s;
}

async function closeServer(s: TestServer): Promise<void> {
  await s.close();
  servers.splice(servers.indexOf(s), 1);
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const dir of dirs) removeDir(dir);
  dirs.clear();
});

class CountingHasher extends PasswordHasher {
  verifies = 0;
  hashes = 0;
  override async verify(password: string, stored: string): Promise<boolean> {
    this.verifies += 1;
    return super.verify(password, stored);
  }
  override async hash(password: string): Promise<string> {
    this.hashes += 1;
    return super.hash(password);
  }
}

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Pauses the next verify() call until released, to force login/password-change interleavings. */
class GatedHasher extends PasswordHasher {
  gate: { entered: Deferred; release: Deferred } | null = null;
  arm(): { entered: Promise<void>; release: () => void } {
    const gate = { entered: deferred(), release: deferred() };
    this.gate = gate;
    return { entered: gate.entered.promise, release: gate.release.resolve };
  }
  override async verify(password: string, stored: string): Promise<boolean> {
    const gate = this.gate;
    if (gate) {
      this.gate = null;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return super.verify(password, stored);
  }
}

describe("SEC-FIX-001 M1 login limiter under concurrency", () => {
  it("20 concurrent wrong logins run at most 5 verifications; the rest are 429", async () => {
    const hasher = new CountingHasher();
    const { app } = await server({ hasher });
    await new TestClient(app).register("alice");
    const before = hasher.verifies;
    const attacker = new TestClient(app);
    await attacker.me();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        attacker.request("POST", "/auth/login", { username: "alice", password: `wrong password ${i}` }),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 401)).toHaveLength(LIMITS.loginAttemptsPerWindow);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20 - LIMITS.loginAttemptsPerWindow);
    expect(hasher.verifies - before).toBeLessThanOrEqual(LIMITS.loginAttemptsPerWindow);
  });
});

describe("SEC-FIX-001 M3 login vs password change", () => {
  it("a login that verified the old password cannot open a session after a change", async () => {
    const hasher = new GatedHasher();
    const { app, db } = await server({ hasher });
    const owner = new TestClient(app);
    await owner.register("alice");
    const sessionsBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'account'").get() as { n: number }
    ).n;

    const late = new TestClient(app);
    await late.me();
    const gate = hasher.arm();
    const pendingLogin = late.request("POST", "/auth/login", { username: "alice", password: PASSWORD });
    await gate.entered;
    const change = await owner.request("POST", "/auth/password", {
      currentPassword: PASSWORD,
      newPassword: "brand new password",
    });
    expect(change.statusCode, change.body).toBe(200);
    gate.release();
    const res = await pendingLogin;
    expect(res.statusCode).toBe(401);
    expect(late.cookies.has("sid")).toBe(false);
    const sessionsAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'account'").get() as { n: number }
    ).n;
    expect(sessionsAfter).toBe(sessionsBefore);
    expect((await new TestClient(app).login("alice", "brand new password")).statusCode).toBe(200);
  });

  it("a slow rehash cannot write the old password's hash back over a change", async () => {
    const legacy: PasswordParams = {
      version: 0,
      memoryKiB: 1024,
      passes: 1,
      parallelism: 1,
      tagLength: 32,
      saltLength: 16,
    };
    const first = await server({ hasher: new PasswordHasher(legacy) });
    await new TestClient(first.app).register("legacy");
    await closeServer(first);

    const hasher = new GatedHasher();
    const second = await server({ dir: first.dir, hasher });
    const slow = new TestClient(second.app);
    await slow.me();
    const gate = hasher.arm();
    const pendingLogin = slow.request("POST", "/auth/login", { username: "legacy", password: PASSWORD });
    await gate.entered;
    const owner = new TestClient(second.app);
    expect((await owner.login("legacy", PASSWORD)).statusCode).toBe(200); // rehashes to current params
    expect(
      (
        await owner.request("POST", "/auth/password", {
          currentPassword: PASSWORD,
          newPassword: "changed password!",
        })
      ).statusCode,
    ).toBe(200);
    gate.release();
    expect((await pendingLogin).statusCode).toBe(401);
    expect((await new TestClient(second.app).login("legacy", PASSWORD)).statusCode).toBe(401);
    expect((await new TestClient(second.app).login("legacy", "changed password!")).statusCode).toBe(200);
  });
});

describe("SEC-FIX-001 M2 guest minting, fetch metadata, purge", () => {
  it("GET /auth/me writes nothing; cross-site and rebinding GETs are refused", async () => {
    const { app, db } = await server();
    for (let i = 0; i < 25; i += 1) {
      expect((await new TestClient(app).request("GET", "/auth/me")).statusCode).toBe(200);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM guests").get()).toEqual({ n: 0 });
    const probe = new TestClient(app);
    probe.origin = null;
    const crossSite = await probe.request("GET", "/auth/me", undefined, { "sec-fetch-site": "cross-site" });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.headers["set-cookie"]).toBeUndefined();
    expect(
      (await probe.request("GET", "/auth/me", undefined, { "sec-fetch-site": "same-site" })).statusCode,
    ).toBe(403);
    expect(
      (await probe.request("GET", "/health", undefined, { host: "rebind.example:5591" })).statusCode,
    ).toBe(403);
    expect(
      (await probe.request("GET", "/auth/me", undefined, { "sec-fetch-site": "same-origin" })).statusCode,
    ).toBe(200);
  });

  it("throttles guest creation and registration per client", async () => {
    const { app } = await server({ guestsPerWindow: 2, registrationsPerWindow: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const c = new TestClient(app);
      await c.me();
      statuses.push((await c.request("PATCH", "/profile", { preferences: { soundMuted: true } })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const regs: number[] = [];
    for (const name of ["reg_a", "reg_b", "reg_c"])
      regs.push((await new TestClient(app).register(name)).statusCode);
    expect(regs).toEqual([201, 201, 429]);
  });

  it("purges revoked/expired sessions and orphaned guests", async () => {
    let now = new Date("2026-10-12T00:00:00.000Z");
    const { app, db } = await server({ clock: () => now });
    const alice = new TestClient(app);
    await alice.register("alice");
    await alice.request("POST", "/auth/logout");
    const guest = new TestClient(app);
    await guest.me();
    await guest.request("PATCH", "/profile", { preferences: { theme: "dark" } });
    now = new Date(now.getTime() + LIMITS.sessionTtlMs + 1);
    const purged = await app.services.auth.purgeInactive();
    expect(purged).toEqual({ sessions: 2, guests: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });
});

describe("SEC-FIX-001 low findings", () => {
  it("L1 builds the dummy hash at startup; L3 caps currentPassword before hashing", async () => {
    const hasher = new CountingHasher();
    const { app } = await server({ hasher });
    expect(hasher.hashes).toBe(1); // warmup dummy
    const alice = new TestClient(app);
    await alice.register("alice");
    const verifies = hasher.verifies;
    const res = await alice.request("POST", "/auth/password", {
      currentPassword: "x".repeat(129),
      newPassword: "another password",
    });
    expect(res.statusCode).toBe(400);
    expect(hasher.verifies).toBe(verifies);
  });

  it("L9 sends a Content-Security-Policy on UI responses", async () => {
    const web = mkdtempSync(join(tmpdir(), "g2048-web-"));
    dirs.add(web);
    writeFileSync(join(web, "index.html"), "<!doctype html><title>t</title>");
    const { app } = await server({ webDist: web });
    const res = await app.inject({
      method: "GET",
      url: "/some/client/route",
      headers: { host: "127.0.0.1:5591" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });

  it("L8 owner reset refuses while the server holds the database or migrations are pending", async () => {
    const s = await server();
    await new TestClient(s.app).register("alice");
    const dbPath = s.dbPath;
    await closeServer(s);
    const release = acquireDatabaseLock(dbPath);
    await expect(ownerResetPassword(dbPath, "alice", "a new valid password")).rejects.toThrow(
      /stop it first/,
    );
    release();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("DELETE FROM schema_migrations");
    raw.close();
    await expect(ownerResetPassword(dbPath, "alice", "a new valid password")).rejects.toThrow(/db:migrate/);
  });
});
