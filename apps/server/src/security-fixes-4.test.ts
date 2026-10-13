import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  RULESETS,
  type BotRunView,
  type GameResponse,
  type GameState,
  type ReplayFile,
} from "@g2048/contracts";
import { competitionRepo, gamesRepo } from "@g2048/database";
import { applyMove, checksum, legalMoves, maxExponent, newGame } from "@g2048/engine";
import { fastChecksum, REPLAY_IMPORT_QUOTA, REPLAY_IMPORTS_PER_MINUTE } from "./services/replay-service.js";
import { removeDir, startTestServer, TestClient, type TestServer } from "./test-support.js";

const servers: TestServer[] = [];
async function server(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(options);
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.close();
    removeDir(s.dir);
  }
});

let n = 0;
const cid = () => `sec4-${String((n += 1)).padStart(6, "0")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signedIn(app: TestServer["app"], name: string): Promise<TestClient> {
  const c = new TestClient(app);
  expect((await c.register(name)).statusCode).toBe(201);
  return c;
}

async function smallReplay(c: TestClient): Promise<ReplayFile> {
  const g = (await c.request("POST", "/games", { mode: "classic", seed: "sec4" })).json() as GameResponse;
  const d = legalMoves(g.state.board)[0];
  await c.request("POST", `/games/${g.game.id}/moves`, {
    commandId: cid(),
    expectedRevision: 0,
    direction: d,
  });
  return (await c.request("GET", `/replays/${g.game.id}`)).json() as ReplayFile;
}

describe("H1 replay import quota and rate limits", () => {
  it("rate limits imports per client and caps stored imports per owner", { timeout: 120_000 }, async () => {
    let now = new Date("2026-10-12T00:00:00.000Z");
    const s = await server({ clock: () => now });
    const c = await signedIn(s.app, "importer");
    const file = await smallReplay(c);
    const statuses: number[] = [];
    for (let i = 0; i < REPLAY_IMPORTS_PER_MINUTE + 1; i += 1)
      statuses.push((await c.request("POST", "/replays/import", file)).statusCode);
    expect(statuses.slice(0, REPLAY_IMPORTS_PER_MINUTE).every((code) => code === 201)).toBe(true);
    expect(statuses[REPLAY_IMPORTS_PER_MINUTE]).toBe(429);

    let stored = REPLAY_IMPORTS_PER_MINUTE;
    let last = 0;
    while (stored <= REPLAY_IMPORT_QUOTA.files) {
      now = new Date(now.getTime() + 61_000);
      for (let i = 0; i < REPLAY_IMPORTS_PER_MINUTE && stored <= REPLAY_IMPORT_QUOTA.files; i += 1) {
        last = (await c.request("POST", "/replays/import", file)).statusCode;
        if (last === 201) stored += 1;
        else break;
      }
      if (last !== 201) break;
    }
    expect(last).toBe(503);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM replay_imports").get()).toEqual({
      n: REPLAY_IMPORT_QUOTA.files,
    });
  });

  it("verifies before creating a guest and stores only canonical, known fields", async () => {
    const s = await server();
    const owner = await signedIn(s.app, "owner");
    const file = await smallReplay(owner);
    const anon = new TestClient(s.app);
    await anon.me();
    const bad = await anon.request("POST", "/replays/import", { ...file, finalChecksum: "0".repeat(64) });
    expect(bad.statusCode).toBe(400);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM guests").get()).toEqual({ n: 0 }); // L1

    const extra = {
      ...file,
      initialState: { ...file.initialState, evil: "x".repeat(1000) },
      junk: { deep: true },
    };
    const ok = await anon.request("POST", "/replays/import", extra);
    expect(ok.statusCode, ok.body).toBe(201);
    const stored = (s.db.prepare("SELECT replay_json FROM replay_imports").get() as { replay_json: string })
      .replay_json;
    expect(stored).not.toContain("evil");
    expect(stored).not.toContain("junk");

    expect(
      (await owner.request("POST", "/replays/import", { ...file, seed: "x".repeat(129) })).statusCode,
    ).toBe(400);
    const unknown = await owner.request("POST", "/replays/import", {
      ...file,
      rulesetVersion: "<script>".repeat(10),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).not.toContain("<script>"); // L2: attacker strings are not echoed
    // Pathologically nested JSON, sent as raw text (the client must not serialize it itself).
    const depth = 20_000;
    const raw = JSON.stringify(file).replace(
      /"displayName":(null|"[^"]*")/,
      `"displayName":${'{"n":'.repeat(depth)}"x"${"}".repeat(depth)}`,
    );
    const deep = await owner.request("POST", "/replays/import", raw, { "content-type": "application/json" });
    expect(deep.statusCode).toBe(400);
  });

  it("verification uses the same checksum as the engine", () => {
    let state = newGame(RULESETS["classic-v1"], "fast");
    for (let i = 0; i < 20; i += 1) {
      expect(fastChecksum(state)).toBe(checksum(state));
      const d = legalMoves(state.board)[0];
      if (!d) break;
      state = applyMove(state, d, RULESETS["classic-v1"]).state;
    }
  });
});

describe("H2 bot-run limits", () => {
  const start = (c: TestClient, extra: Record<string, unknown> = {}) =>
    c.request("POST", "/bots/runs", {
      strategy: "random-v1",
      nodeBudget: 10,
      timeBudgetMs: 1000,
      seed: "h2",
      maxMoves: 1000,
      ...extra,
    });
  async function waitTerminal(c: TestClient, id: string): Promise<BotRunView> {
    for (let i = 0; i < 400; i += 1) {
      const view = (await c.request("GET", `/bots/runs/${id}`)).json() as BotRunView;
      if (["finished", "cancelled", "failed"].includes(view.status)) return view;
      await sleep(25);
    }
    throw new Error("run did not end");
  }

  it("caps active runs per owner and cancels idle paused runs", { timeout: 60_000 }, async () => {
    const s = await server({ botRunLimits: { idleTimeoutMs: 100 } });
    const c = await signedIn(s.app, "botowner");
    const a = (await start(c, { stepMode: true })).json() as BotRunView;
    const b = (await start(c, { stepMode: true })).json() as BotRunView;
    const third = await start(c, { stepMode: true });
    expect(third.statusCode).toBe(503);
    const other = await signedIn(s.app, "someone_else");
    expect((await start(other, { stepMode: true })).statusCode).toBe(201); // per owner, not global
    const va = await waitTerminal(c, a.id);
    const vb = await waitTerminal(c, b.id);
    expect([va.status, vb.status]).toEqual(["cancelled", "cancelled"]);
    const metrics = (
      s.db.prepare("SELECT metrics_json FROM bot_runs WHERE id = ?").get(a.id) as { metrics_json: string }
    ).metrics_json;
    expect(JSON.parse(metrics)).toMatchObject({ cancelReason: "idle" });
    expect((await start(c)).statusCode).toBe(201); // slots freed
  });

  it("enforces a whole-run wall-clock limit", { timeout: 60_000 }, async () => {
    const s = await server({ botRunLimits: { maxWallClockMs: 150 } });
    const c = await signedIn(s.app, "longrunner");
    const run = (
      await start(c, {
        strategy: "expectimax-v1",
        nodeBudget: 5_000_000,
        timeBudgetMs: 10_000,
        maxMoves: 100_000,
      })
    ).json() as BotRunView;
    const view = await waitTerminal(c, run.id);
    expect(view.status).toBe("cancelled");
    const metrics = (
      s.db.prepare("SELECT metrics_json FROM bot_runs WHERE id = ?").get(run.id) as { metrics_json: string }
    ).metrics_json;
    expect(JSON.parse(metrics)).toMatchObject({ cancelReason: "wall-clock" });
  });

  it(
    "keeps only the newest finished runs and their games per owner; late status writes never revive a run",
    { timeout: 60_000 },
    async () => {
      const s = await server({ botRunLimits: { keepRunsPerOwner: 1 } });
      const c = await signedIn(s.app, "retention");
      const first = await waitTerminal(c, ((await start(c, { maxMoves: 5 })).json() as BotRunView).id);
      const second = await waitTerminal(
        c,
        ((await start(c, { maxMoves: 5, seed: "h2b" })).json() as BotRunView).id,
      );
      expect(first.gameId && second.gameId).toBeTruthy();
      expect(s.db.prepare("SELECT id FROM bot_runs").all()).toEqual([{ id: second.id }]);
      expect(gamesRepo.get(s.db, first.gameId as string)).toBeNull();
      expect(gamesRepo.get(s.db, second.gameId as string)).not.toBeNull();
      // M4: a late pause/resume on a finished run is a no-op
      expect(((await c.request("POST", `/bots/runs/${second.id}/pause`)).json() as BotRunView).status).toBe(
        "finished",
      );
      const changed = await s.app.services.ctx.writer.run((tx) =>
        competitionRepo.updateActiveBotRunStatus(tx, second.id, "running", new Date().toISOString()),
      );
      expect(changed).toBe(false);
    },
  );
});

describe("M5 duel replays follow the match, L7 match events are append-only", () => {
  it("hides a duel seat's replay until the match is finished", async () => {
    const s = await server();
    const a = await signedIn(s.app, "duelist");
    const b = await signedIn(s.app, "watcher");
    const uid = (
      s.db.prepare("SELECT id FROM users WHERE username_normalized = 'duelist'").get() as { id: string }
    ).id;
    const now = new Date().toISOString();
    const matchId = randomUUID();
    s.db
      .prepare(
        "INSERT INTO matches (id, kind, season_id, ruleset_version, seed, status, created_at, updated_at) VALUES (?, 'human-human', 'duel-s1', 'duel-v1', 'm', 'active', ?, ?)",
      )
      .run(matchId, now, now);
    const game = await s.app.services.ctx.writer.run((tx) =>
      s.app.services.games.createInTransaction(
        tx,
        { userId: uid },
        { mode: "duel-human", rules: RULESETS["duel-v1"], seed: "m" },
      ),
    );
    s.db
      .prepare(
        "INSERT INTO match_seats (match_id, seat, user_id, game_id, joined_at) VALUES (?, 'a', ?, ?, ?)",
      )
      .run(matchId, uid, game.id, now);
    // the seat itself is over (forfeited), but the opponent may still be playing the same seed
    const ended: GameState = { ...game.state, status: "forfeited" };
    gamesRepo.updateState(s.db, game.id, 0, ended, checksum(ended), maxExponent(ended.board), now);
    expect((await a.request("GET", `/replays/${game.id}`)).statusCode).toBe(404);
    expect((await b.request("GET", `/replays/${game.id}`)).statusCode).toBe(404);
    s.db
      .prepare("UPDATE matches SET status = 'finished', outcome = 'seat-b', finalized_at = ? WHERE id = ?")
      .run(now, matchId);
    expect((await b.request("GET", `/replays/${game.id}`)).statusCode).toBe(200);

    s.db
      .prepare(
        "INSERT INTO match_events (match_id, sequence, type, payload_json, created_at) VALUES (?, 1, 'match.finished', '{}', ?)",
      )
      .run(matchId, now);
    expect(() => s.db.prepare("UPDATE match_events SET payload_json = '{\"x\":1}'").run()).toThrow(
      /append-only/,
    );
    expect(() => s.db.prepare("DELETE FROM match_events").run()).toThrow(/append-only/);
  });
});

describe("refused WebSocket upgrades never leave sockets open", () => {
  it(
    "destroys the socket of an upgrade refused by the root hook and closes promptly",
    { timeout: 30_000 },
    async () => {
      const { request: httpRequest } = await import("node:http");
      const s = await startTestServer({});
      await s.app.listen({ host: "127.0.0.1", port: 0 });
      const address = s.app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const attempt = (path: string, host: string) =>
        new Promise<{ status: number | null; closed: boolean }>((resolve) => {
          const req = httpRequest({
            host: "127.0.0.1",
            port,
            path,
            headers: {
              host,
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-version": "13",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            },
          });
          let status: number | null = null;
          const timer = setTimeout(() => resolve({ status, closed: false }), 3_000);
          req.on("response", (res) => {
            status = res.statusCode ?? null;
            res.resume();
            res.socket.on("close", () => {
              clearTimeout(timer);
              resolve({ status, closed: true });
            });
          });
          req.on("upgrade", () => resolve({ status: 101, closed: false }));
          req.on("error", () => {
            clearTimeout(timer);
            resolve({ status, closed: true });
          });
          req.end();
        });
      expect(await attempt("/api/v1/events", "evil.example")).toEqual({ status: 403, closed: true });
      expect(await attempt("/api/v1/not-a-socket", "evil.example")).toEqual({ status: 403, closed: true });
      const started = Date.now();
      await s.close();
      removeDir(s.dir);
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );

  it("reports why a run was cancelled", { timeout: 60_000 }, async () => {
    const s = await server();
    const c = await signedIn(s.app, "canceller");
    const run = (
      await c.request("POST", "/bots/runs", {
        strategy: "random-v1",
        nodeBudget: 10,
        timeBudgetMs: 1000,
        seed: "c",
        maxMoves: 100,
        stepMode: true,
      })
    ).json() as BotRunView;
    const view = (await c.request("POST", `/bots/runs/${run.id}/cancel`)).json() as BotRunView & {
      cancelReason: string | null;
    };
    expect(view).toMatchObject({ status: "cancelled", cancelReason: "user" });
  });
});
