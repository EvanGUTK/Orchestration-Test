// ACC-01..ACC-04 (docs/ACCEPTANCE.md) against the Fastify app via inject, private temp DB per test.
// Spec sources: docs/PROJECT_SCOPE.md "Local identity and privacy", docs/ARCHITECTURE.md
// "Transactions and concurrency", CONTRACT-001 "HTTP / WebSocket / DB", contracts api.ts/errors.ts/limits.ts.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@g2048/contracts";
import type { GameResponse, MeResponse } from "@g2048/contracts";
import { createTestApp } from "./helpers/app.js";
import type { TestApp } from "./helpers/app.js";
import { Client, FOREIGN_ORIGIN, ORIGIN, expectErrorEnvelope } from "./helpers/http.js";
import type { Res } from "./helpers/http.js";

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another long passphrase";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

function expectSignedOut(res: Res<MeResponse>): void {
  if (res.status === 200) expect(res.json.user).toBeNull();
  else expect(res.status).toBe(401);
}
const ok = (status: number) => status === 200 || status === 201 || status === 204;

async function createGame(c: Client): Promise<string> {
  const r = await c.post<GameResponse>("/games", { mode: "classic" });
  if (r.status !== 201) throw new Error(`create game: ${r.status} ${r.text}`);
  return r.json.game.id;
}

describe("ACC-01 create / log in / log out / change password", () => {
  it("register + login set an HttpOnly SameSite=Strict sid cookie; /auth/me exposes no secrets", async () => {
    const c = new Client(t.app);
    const reg = await c.register("alice", "Alice", PASSWORD);
    // documented shape (backend, CONTRACT-001 C8): 201 + MeResponse
    expect(reg.status, reg.text).toBe(201);
    expect((reg.json as MeResponse).user?.username).toBe("alice");
    const login = await c.login("alice", PASSWORD);
    expect(login.status, login.text).toBe(200);
    const sid = login.cookies.find((k) => k.name === "sid");
    expect(sid, "sid cookie").toBeDefined();
    expect(sid?.attributes.httponly).toBe(true);
    expect(String(sid?.attributes.samesite).toLowerCase()).toBe("strict");
    expect(sid?.attributes.path).toBe("/");
    const me = await c.me();
    expect(me.status).toBe(200);
    expect(me.json.user?.username).toBe("alice");
    expect(me.json.user?.displayName).toBe("Alice");
    expect(typeof me.json.csrfToken).toBe("string");
    for (const text of [reg.text, login.text, me.text]) {
      expect(text).not.toContain(PASSWORD);
      expect(text.toLowerCase()).not.toContain("argon2");
      expect(text.toLowerCase()).not.toMatch(/password_?hash|token_?hash/);
      if (sid) expect(text).not.toContain(sid.value);
    }
  });

  it("passwords are stored as Argon2id hashes and sessions as token hashes only", async () => {
    const c = new Client(t.app);
    await c.signUp("bob", PASSWORD);
    const user = t.db.prepare("SELECT * FROM users WHERE username_normalized = ?").get("bob") as Record<
      string,
      unknown
    >;
    expect(user).toBeDefined();
    expect(String(user.password_hash)).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
    const sid = c.jar.get("sid");
    expect(sid).toBeDefined();
    // 256-bit token: at least 43 base64url chars or 64 hex chars
    expect((sid ?? "").length).toBeGreaterThanOrEqual(43);
    const sessions = t.db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
    expect(sessions.length).toBeGreaterThan(0);
    expect(JSON.stringify(sessions)).not.toContain(sid as string);
  });

  it("logout revokes the session server-side; a replayed cookie is rejected", async () => {
    const c = new Client(t.app);
    await c.signUp("carol", PASSWORD);
    const stolen = c.jar.get("sid") as string;
    const out = await c.logout();
    expect(ok(out.status), out.text).toBe(true);
    expectSignedOut(await c.me());
    const replay = new Client(t.app);
    replay.jar.set("sid", stolen);
    expectSignedOut(await replay.me());
    expect(out.json).toMatchObject({ ok: true, revokedSessions: 1 });
    const revoked = t.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NOT NULL").get() as {
      n: number;
    };
    expect(revoked.n).toBeGreaterThanOrEqual(1);
  });

  it("POST /auth/logout {allSessions:true} clears every session of the account", async () => {
    const a1 = new Client(t.app);
    await a1.signUp("frank", PASSWORD);
    const a2 = new Client(t.app);
    expect((await a2.login("frank", PASSWORD)).status).toBe(200);
    const other = new Client(t.app);
    await other.signUp("bystander", PASSWORD);

    const out = await a1.post("/auth/logout", { allSessions: true });
    expect(out.status, out.text).toBe(200);
    expect((out.json as { ok: boolean; revokedSessions: number }).ok).toBe(true);
    expect((out.json as { revokedSessions: number }).revokedSessions).toBeGreaterThanOrEqual(2);
    expectSignedOut(await a1.me());
    expectSignedOut(await a2.me());
    expect((await other.me()).json.user?.username).toBe("bystander");
  });

  it("changing the password revokes other sessions; old password fails, new one works", async () => {
    const a1 = new Client(t.app);
    await a1.signUp("dave", PASSWORD);
    const a2 = new Client(t.app);
    expect((await a2.login("dave", PASSWORD)).status).toBe(200);

    const wrong = await a1.post("/auth/password", {
      currentPassword: "not the password!",
      newPassword: NEW_PASSWORD,
    });
    expect([400, 401, 403]).toContain(wrong.status);
    expectErrorEnvelope(wrong);

    const change = await a1.post("/auth/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(change.status, change.text).toBe(200);
    expect(change.json).toMatchObject({ ok: true });
    expect((change.json as { revokedSessions: number }).revokedSessions).toBeGreaterThanOrEqual(1);
    expectSignedOut(await a2.me());

    const old = await new Client(t.app).login("dave", PASSWORD);
    expect(old.status).toBe(401);
    expectErrorEnvelope(old, "UNAUTHENTICATED");
    expect((await new Client(t.app).login("dave", NEW_PASSWORD)).status).toBe(200);
  });

  it("login failures are generic: unknown user and wrong password are indistinguishable", async () => {
    await new Client(t.app).register("erin", "Erin", PASSWORD);
    const unknown = await new Client(t.app).login("nobody_here", PASSWORD);
    const wrong = await new Client(t.app).login("erin", "wrong password!!");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expectErrorEnvelope(unknown, "UNAUTHENTICATED");
    expectErrorEnvelope(wrong, "UNAUTHENTICATED");
    const msg = (r: Res) => (r.json as { error: { message: string } }).error.message;
    expect(msg(unknown)).toBe(msg(wrong));
  });
});

describe("ACC-02 username normalization and input limits", () => {
  it("usernames normalize to ASCII lowercase; case variants are duplicates", async () => {
    const c = new Client(t.app);
    await c.signUp("Player_One", PASSWORD, "P1");
    expect((await c.me()).json.user?.username).toBe("player_one");
    for (const variant of ["player_one", "PLAYER_ONE", "pLaYeR_oNe"]) {
      const dup = await new Client(t.app).register(variant, "Dup", PASSWORD);
      expect([400, 409], `${variant}: ${dup.text}`).toContain(dup.status);
      expectErrorEnvelope(dup);
    }
    expect((await new Client(t.app).login("PLAYER_ONE", PASSWORD)).status).toBe(200);
    const rows = t.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(25)],
    ["hyphen", "bad-name"],
    ["space", "has space"],
    ["non-ASCII letter", "ünïcode"],
    ["fullwidth letters", "ｐｌａｙｅｒ"],
    ["empty", ""],
  ])("rejects username %s", async (_label, username) => {
    const r = await new Client(t.app).register(username, "Name", PASSWORD);
    expect(r.status, r.text).toBe(400);
    expectErrorEnvelope(r, "VALIDATION_ERROR");
  });

  it("accepts usernames of exactly 3 and 24 characters", async () => {
    for (const u of ["abc", "a".repeat(24)]) {
      const r = await new Client(t.app).register(u, "Name", PASSWORD);
      expect(ok(r.status), `${u}: ${r.text}`).toBe(true);
    }
  });

  it("passwords are 12-128 Unicode code points (not UTF-16 units)", async () => {
    const cases: [string, string, boolean][] = [
      ["pw_11", "x".repeat(11), false],
      ["pw_12", "x".repeat(12), true],
      ["pw_128", "x".repeat(128), true],
      ["pw_129", "x".repeat(129), false],
      ["pw_emoji12", "😀".repeat(12), true],
      ["pw_emoji11", "😀".repeat(11), false], // 22 UTF-16 units but only 11 code points
    ];
    for (const [u, pw, accepted] of cases) {
      const r = await new Client(t.app).register(u, "Name", pw);
      if (accepted) expect(ok(r.status), `${u}: ${r.text}`).toBe(true);
      else {
        expect(r.status, `${u}: ${r.text}`).toBe(400);
        expectErrorEnvelope(r, "VALIDATION_ERROR");
      }
    }
  });

  it("display names are 1-48 code points and round-trip verbatim as text", async () => {
    for (const [u, name] of [
      ["dn_empty", ""],
      ["dn_49", "n".repeat(49)],
      ["dn_emoji49", "🎲".repeat(49)],
    ] as const) {
      const r = await new Client(t.app).register(u, name, PASSWORD);
      expect(r.status, `${u}: ${r.text}`).toBe(400);
    }
    for (const name of ["🎲".repeat(48), "<script>alert(1)</script>", "Zoë & \"Q\" 'x'"]) {
      const c = new Client(t.app);
      const u = `dn_${Math.abs([...name].reduce((h, ch) => (h * 31 + (ch.codePointAt(0) ?? 0)) | 0, 7)) % 1_000_000}`;
      await c.signUp(u, PASSWORD, name);
      const me = await c.me();
      expect(String(me.headers["content-type"])).toMatch(/application\/json/);
      expect(me.json.user?.displayName).toBe(name);
    }
  });
});

describe("ACC-03 two accounts and a guest are isolated", () => {
  it("another account cannot read, list, or move a user's game", async () => {
    const a = new Client(t.app);
    await a.signUp("owner_a", PASSWORD);
    const b = new Client(t.app);
    await b.signUp("intruder_b", PASSWORD);
    const gameId = await createGame(a);

    const read = await b.get(`/games/${gameId}`);
    expect([403, 404]).toContain(read.status);
    expectErrorEnvelope(read);
    const move = await b.post(`/games/${gameId}/moves`, {
      commandId: "intruder-0001",
      expectedRevision: 0,
      direction: "left",
    });
    expect([403, 404]).toContain(move.status);
    const forfeit = await b.post(`/games/${gameId}/forfeit`, {
      commandId: "intruder-0002",
      expectedRevision: 0,
    });
    expect([403, 404]).toContain(forfeit.status);
    const list = await b.get<{ items: { id: string }[] }>("/games");
    expect(list.status).toBe(200);
    expect(list.json.items.map((g) => g.id)).not.toContain(gameId);

    const mine = await a.get<GameResponse>(`/games/${gameId}`);
    expect(mine.status).toBe(200);
    expect(mine.json.state.revision).toBe(0);
    expect(mine.json.state.status).toBe("active");
  });

  it("a guest gets its own opaque gid session and cannot touch account games (or vice versa)", async () => {
    const a = new Client(t.app);
    await a.signUp("owner_c", PASSWORD);
    const accountGame = await createGame(a);

    const guest = new Client(t.app);
    const guestGame = await createGame(guest);
    const gid = [...guest.jar.keys()].includes("gid");
    expect(gid, "guest cookie gid").toBe(true);
    expect(guest.jar.has("sid")).toBe(false);
    const me = await guest.me();
    expect(me.status).toBe(200);
    expect(me.json.user).toBeNull();
    expect(me.json.guest?.id).toEqual(expect.any(String));

    expect([401, 403, 404]).toContain((await guest.get(`/games/${accountGame}`)).status);
    expect([403, 404]).toContain((await a.get(`/games/${guestGame}`)).status);
    expect((await guest.get(`/games/${guestGame}`)).status).toBe(200);
  });

  it("a guest can never enter a human ranked challenge", async () => {
    const a = new Client(t.app);
    await a.signUp("lister", PASSWORD);
    const list = await a.get<{ items: { id: string }[] }>("/challenges");
    expect(list.status).toBe(200);
    const items = list.json.items; // C17: Page<ChallengeSummary>
    const challenge = items[0];
    expect(challenge, "the local challenge catalog must contain at least one challenge").toBeDefined();
    const guest = new Client(t.app);
    await guest.me();
    const attempt = await guest.post(`/challenges/${challenge?.id}/attempts`, {});
    expect(attempt.status, attempt.text).toBe(403); // C17: guests -> 403 FORBIDDEN
    expectErrorEnvelope(attempt, "FORBIDDEN");
  });
});

describe("ACC-04 CSRF / Origin / Host and rate limits", () => {
  it("a foreign Origin cannot register or log out (session survives)", async () => {
    const evilReg = await new Client(t.app).post(
      "/auth/register",
      { username: "victim", displayName: "V", password: PASSWORD },
      { origin: FOREIGN_ORIGIN },
    );
    expect(evilReg.status).toBe(403);
    expectErrorEnvelope(evilReg, "FORBIDDEN");
    expect((await new Client(t.app).login("victim", PASSWORD)).status).toBe(401);

    const c = new Client(t.app);
    await c.signUp("victim2", PASSWORD);
    const evilOut = await c.post("/auth/logout", undefined, { origin: FOREIGN_ORIGIN });
    expect(evilOut.status).toBe(403);
    expect((await c.me()).json.user?.username).toBe("victim2");
  });

  it("mutating requests without or with a wrong CSRF token are rejected", async () => {
    const c = new Client(t.app);
    await c.signUp("csrf_user", PASSWORD);
    const none = await c.post("/auth/logout", undefined, { csrf: false });
    expect(none.status).toBe(403);
    expectErrorEnvelope(none, "FORBIDDEN");
    const wrong = await c.post("/auth/logout", undefined, { csrf: "forged-token-value" });
    expect(wrong.status).toBe(403);
    expect((await c.me()).json.user?.username).toBe("csrf_user");

    const pw = await c.post(
      "/auth/password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { csrf: false },
    );
    expect(pw.status).toBe(403);
    expect((await new Client(t.app).login("csrf_user", PASSWORD)).status).toBe(200);

    const real = await c.post("/auth/logout");
    expect(real.status).toBe(200);
    expectSignedOut(await c.me());
  });

  it("without an Origin header, a foreign Host is rejected", async () => {
    const c = new Client(t.app);
    await c.signUp("host_user", PASSWORD);
    const r = await c.post("/auth/logout", undefined, { origin: null, host: "evil.example" });
    expect(r.status).toBe(403);
    expect((await c.me()).json.user?.username).toBe("host_user");
  });

  it(`login attempts are bounded: after ${LIMITS.loginAttemptsPerWindow} failures the next attempt is 429`, async () => {
    await new Client(t.app).register("target", "Target", PASSWORD);
    const attacker = new Client(t.app);
    for (let i = 0; i < LIMITS.loginAttemptsPerWindow; i++) {
      const r = await attacker.login("target", `wrong password ${i}`);
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    const limited = await attacker.login("target", "wrong password again");
    expect(limited.status).toBe(429);
    expectErrorEnvelope(limited, "RATE_LIMITED");
    const evenCorrect = await attacker.login("target", PASSWORD);
    expect(evenCorrect.status).toBe(429);
  });

  it("~20 concurrent wrong logins: at most the window's allowance is not rate-limited", async () => {
    await new Client(t.app).register("target2", "Target", PASSWORD);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => new Client(t.app).login("target2", `wrong password ${i}!`)),
    );
    const statuses = attempts.map((r) => r.status);
    const notLimited = statuses.filter((s) => s !== 429);
    expect(notLimited.length, `statuses: ${statuses.join(",")}`).toBeLessThanOrEqual(
      LIMITS.loginAttemptsPerWindow,
    );
    expect(
      notLimited.every((s) => s === 401),
      `statuses: ${statuses.join(",")}`,
    ).toBe(true);
    expect((await new Client(t.app).login("target2", PASSWORD)).status).toBe(429);
  });

  it("WebSocket upgrades from a foreign Origin are refused (same-origin with a session upgrades)", async () => {
    const c = new Client(t.app);
    await c.signUp("ws_user", PASSWORD);
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    const upgrade = (origin: string) =>
      new Promise<number>((resolveStatus, reject) => {
        const req = request({
          host: "127.0.0.1",
          port,
          path: "/api/v1/events",
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            origin,
            host: `127.0.0.1:${port}`,
            cookie: c.cookieHeader(),
          },
        });
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolveStatus(101);
        });
        req.on("response", (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect([400, 401, 403]).toContain(await upgrade(FOREIGN_ORIGIN));
    // positive control proves the refusal is an Origin check, not a missing route
    expect(await upgrade(ORIGIN.replace("5512", String(port)))).toBe(101);
  });
});
