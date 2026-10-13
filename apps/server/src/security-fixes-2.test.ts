import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_BASE,
  LIMITS,
  RULESETS,
  type Direction,
  type GameResponse,
  type MoveResponse,
} from "@g2048/contracts";
import { lockHolder } from "@g2048/database";
import { legalMoves } from "@g2048/engine";
import { ownerResetPassword } from "./owner-reset.js";
import { PasswordHasher } from "./security/passwords.js";
import { MAX_ACTIVE_GAMES_PER_OWNER, NO_CHANGE_RETENTION } from "./services/game-service.js";
import { removeDir, startTestServer, TEST_HOST, TestClient, type TestServer } from "./test-support.js";

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

let n = 0;
const cid = () => `sec2-${String((n += 1)).padStart(6, "0")}`;

async function signedIn(app: TestServer["app"], name: string): Promise<TestClient> {
  const c = new TestClient(app);
  expect((await c.register(name)).statusCode).toBe(201);
  return c;
}

function userId(s: TestServer, name: string): string {
  return (s.db.prepare("SELECT id FROM users WHERE username_normalized = ?").get(name) as { id: string }).id;
}

describe("R2-01 encoded paths cannot bypass Host / fetch-metadata checks", () => {
  const raw = (s: TestServer, method: "GET" | "HEAD", url: string, headers: Record<string, string>) =>
    s.app.inject({ method, url, headers: { host: TEST_HOST, ...headers } });

  it("rejects rebinding hosts and cross-site fetches on every encoded API variant, GET and HEAD", async () => {
    const s = await server();
    for (const url of [
      "/%61pi/v1/auth/me",
      "/%61pi/v1/games",
      "/%2561pi/v1/auth/me",
      "/API/v1/auth/me",
      `${API_BASE}/auth/me`,
    ]) {
      for (const method of ["GET", "HEAD"] as const) {
        const rebinding = await raw(s, method, url, { host: "evil.example:5591" });
        expect(rebinding.statusCode, `${method} ${url} rebinding`).toBe(403);
        const crossSite = await raw(s, method, url, { "sec-fetch-site": "cross-site" });
        expect(crossSite.statusCode, `${method} ${url} cross-site`).toBe(403);
        expect(crossSite.headers["cache-control"]).toBe("no-store");
      }
    }
    const decoded = await raw(s, "GET", "/%61pi/v1/auth/me", {});
    expect(decoded.statusCode).toBe(200); // same route, legitimate caller
    expect(decoded.headers["cache-control"]).toBe("no-store");
  });

  it("fails closed for static files and 404s; only a cross-site top-level UI navigation is allowed", async () => {
    const web = mkdtempSync(join(tmpdir(), "g2048-web-"));
    dirs.add(web);
    writeFileSync(join(web, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(web, "app.js"), "console.log(1)");
    const s = await server({ webDist: web });
    expect((await raw(s, "GET", "/app.js", { host: "evil.example" })).statusCode).toBe(403);
    expect(
      (await raw(s, "GET", "/app.js", { "sec-fetch-site": "cross-site", "sec-fetch-dest": "script" }))
        .statusCode,
    ).toBe(403);
    expect((await raw(s, "GET", "/nope/route", { host: "evil.example" })).statusCode).toBe(403);
    const nav = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    expect((await raw(s, "GET", "/", nav)).statusCode).toBe(200);
    expect((await raw(s, "GET", "/modes", nav)).statusCode).toBe(200);
    expect((await raw(s, "GET", `${API_BASE}/auth/me`, nav)).statusCode).toBe(403);
    expect((await raw(s, "GET", "/%61pi/v1/auth/me", nav)).statusCode).toBe(403);
    const asset = await raw(s, "GET", "/app.js", {});
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).not.toBe("no-store");
    expect(asset.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect((await raw(s, "GET", "/modes", {})).headers["cache-control"]).toBe("no-store");
  });
});

describe("R2-02 generic /games routes only reach allowlisted modes", () => {
  it("duel and bot-vs-bot games are 404; bot-exhibition is read-only; ranked is delegated without rng", async () => {
    const s = await server();
    const alice = await signedIn(s.app, "alice");
    const uid = userId(s, "alice");
    const make = (mode: "duel-human" | "bot-vs-bot" | "bot-exhibition" | "ranked") =>
      s.app.services.ctx.writer.run((tx) =>
        s.app.services.games.createInTransaction(tx, mode === "bot-vs-bot" ? null : { userId: uid }, {
          mode,
          rules:
            mode === "ranked"
              ? RULESETS["ranked-v1"]
              : mode === "bot-exhibition"
                ? RULESETS["bot-v1"]
                : RULESETS["duel-v1"],
          seed: `seed-${mode}`,
        }),
      );
    for (const mode of ["duel-human", "bot-vs-bot"] as const) {
      const game = await make(mode);
      const id = game.id;
      expect((await alice.request("GET", `/games/${id}`)).statusCode, mode).toBe(404);
      expect((await alice.request("GET", `/games/${id}/events`)).statusCode, mode).toBe(404);
      const dir = legalMoves(game.state.board)[0] as Direction;
      expect(
        (
          await alice.request("POST", `/games/${id}/moves`, {
            commandId: cid(),
            expectedRevision: 0,
            direction: dir,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await alice.request("POST", `/games/${id}/undo`, { commandId: cid(), expectedRevision: 0 }))
          .statusCode,
      ).toBe(404);
      expect(
        (await alice.request("POST", `/games/${id}/forfeit`, { commandId: cid(), expectedRevision: 0 }))
          .statusCode,
      ).toBe(404);
    }
    const bot = await make("bot-exhibition");
    expect((await alice.request("GET", `/games/${bot.id}`)).statusCode).toBe(200);
    expect(
      (
        await alice.request("POST", `/games/${bot.id}/moves`, {
          commandId: cid(),
          expectedRevision: 0,
          direction: legalMoves(bot.state.board)[0],
        })
      ).statusCode,
    ).toBe(404);
    expect(((await alice.request("GET", "/games")).json() as { items: unknown[] }).items).toEqual([]);

    // R2-06: ranked responses never carry the PRNG state; casual ones do.
    const ranked = await make("ranked");
    const got = (await alice.request("GET", `/games/${ranked.id}`)).json() as GameResponse;
    expect(got.state).not.toHaveProperty("rng");
    const moved = (
      await alice.request("POST", `/games/${ranked.id}/moves`, {
        commandId: cid(),
        expectedRevision: 0,
        direction: legalMoves(ranked.state.board)[0],
      })
    ).json() as MoveResponse;
    expect(moved.changed).toBe(true);
    expect(moved.state).not.toHaveProperty("rng");
    const classic = (await alice.request("POST", "/games", { mode: "classic" })).json() as GameResponse;
    expect(classic.state.rng.words).toHaveLength(4);
  });
});

describe("R2-03 pending guest tokens are server-minted", () => {
  it("ignores client-chosen gid values and adopts only tokens this server issued", async () => {
    const { app, db } = await server();
    for (const forged of ["A".repeat(43), `${"B".repeat(43)}.${"C".repeat(43)}`]) {
      const c = new TestClient(app);
      c.cookies.set("gid", forged);
      const me = (await c.me()) as { csrfToken: string };
      expect(c.cookies.get("gid")).not.toBe(forged); // replaced by a server-minted token
      expect(me.csrfToken.length).toBeGreaterThan(20);
      const game = await c.request("POST", "/games", { mode: "classic" });
      expect(game.statusCode).toBe(201);
    }
    const forgedOnly = new TestClient(app);
    forgedOnly.cookies.set("gid", `${"D".repeat(43)}.${"E".repeat(43)}`);
    forgedOnly.csrf = "anything";
    expect((await forgedOnly.request("POST", "/games", { mode: "classic" })).statusCode).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS n FROM guests").get() as { n: number }).n).toBe(2);
  });
});

describe("R2-04 owner reset holds the database lock", () => {
  it("holds <db>.lock for the whole reset and releases it afterwards", async () => {
    const s = await server();
    await signedIn(s.app, "alice");
    const dbPath = s.dbPath;
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    let sawLock = false;
    class ObservingHasher extends PasswordHasher {
      override async hash(password: string): Promise<string> {
        sawLock = lockHolder(dbPath)?.pid === process.pid;
        return super.hash(password);
      }
    }
    await ownerResetPassword(dbPath, "alice", "owner reset password", new ObservingHasher());
    expect(sawLock).toBe(true);
    expect(lockHolder(dbPath)).toBeNull();
  });
});

describe("R2-05 resource caps and retention", () => {
  it("caps unfinished games per owner and keeps only recent no-change commands", async () => {
    const s = await server();
    const alice = await signedIn(s.app, "alice");
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_GAMES_PER_OWNER; i += 1) {
      ids.push(
        (
          (
            await alice.request("POST", "/games", { mode: "classic", seed: `cap-${i}` })
          ).json() as GameResponse
        ).game.id,
      );
    }
    const over = await alice.request("POST", "/games", { mode: "classic" });
    expect(over.statusCode).toBe(503);
    expect((over.json() as { error: { code: string } }).error.code).toBe("RESOURCE_LIMIT");
    await alice.request("POST", `/games/${ids[0]}/forfeit`, { commandId: cid(), expectedRevision: 0 });
    expect((await alice.request("POST", "/games", { mode: "classic" })).statusCode).toBe(201);

    // find a game with a no-op direction and spam it
    let target: GameResponse | null = null;
    let noop: Direction | undefined;
    for (let i = 0; i < 60 && !noop; i += 1) {
      await alice.request("POST", `/games/${ids[(i % 20) + 1]}/forfeit`, {
        commandId: cid(),
        expectedRevision: 0,
      });
      target = (
        await alice.request("POST", "/games", { mode: "classic", seed: `noop-${i}` })
      ).json() as GameResponse;
      const legal = legalMoves(target.state.board);
      noop = (["up", "right", "down", "left"] as const).find((d) => !legal.includes(d));
    }
    if (!target || !noop) throw new Error("no no-op seed found");
    for (let i = 0; i < NO_CHANGE_RETENTION + 7; i += 1) {
      const r = await alice.request("POST", `/games/${target.game.id}/moves`, {
        commandId: cid(),
        expectedRevision: 0,
        direction: noop,
      });
      expect(r.statusCode).toBe(200);
    }
    const kept = s.db
      .prepare("SELECT COUNT(*) AS n FROM game_commands WHERE game_id = ? AND outcome = 'no-change'")
      .get(target.game.id) as { n: number };
    expect(kept.n).toBe(NO_CHANGE_RETENTION);
  });

  it("caps total guests and purges abandoned guests with their games", async () => {
    let now = new Date("2026-10-12T00:00:00.000Z");
    const s = await server({ maxGuests: 1, clock: () => now });
    const g1 = new TestClient(s.app);
    await g1.me();
    expect((await g1.request("POST", "/games", { mode: "classic" })).statusCode).toBe(201);
    const g2 = new TestClient(s.app);
    await g2.me();
    const refused = await g2.request("POST", "/games", { mode: "classic" });
    expect(refused.statusCode).toBe(503);
    now = new Date(now.getTime() + LIMITS.sessionTtlMs + 31 * 24 * 60 * 60 * 1000);
    expect(await s.app.services.auth.purgeInactive()).toEqual({ sessions: 1, guests: 1 });
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 0 });
  });
});
