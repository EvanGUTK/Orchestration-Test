import { afterEach, describe, expect, it } from "vitest";
import { decideDuel } from "@g2048/competition";
import { legalMoves } from "@g2048/engine";
import { TestClient, type TestServer } from "../test-support.js";
import type { MatchDetail } from "./service.js";
import {
  account,
  cid,
  getMatch,
  json,
  playSeat,
  removeDir,
  seatMove,
  startMatchServer,
  waitFor,
} from "./test-kit.js";

const servers: TestServer[] = [];
async function server(options: Parameters<typeof startMatchServer>[0] = {}): Promise<TestServer> {
  const s = await startMatchServer(options);
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.close();
    removeDir(s.dir);
  }
});

type ErrorBody = { error: { code: string; details?: Record<string, unknown> } };
function expectError(
  res: { statusCode: number; json: () => unknown; body: string },
  status: number,
  code: string,
) {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as ErrorBody).error.code).toBe(code);
}

function ratingEvents(s: TestServer, matchId: string) {
  return s.db
    .prepare(
      "SELECT user_id, rating_before, rating_after, delta, outcome FROM rating_events WHERE match_id = ? ORDER BY id",
    )
    .all(matchId) as {
    user_id: string;
    rating_before: number;
    rating_after: number;
    delta: number;
    outcome: string;
  }[];
}

async function lobbyAndJoin(s: TestServer): Promise<{ a: TestClient; b: TestClient; match: MatchDetail }> {
  const a = await account(s.app, `alice_${servers.length}${Math.floor(Math.random() * 1e6)}`);
  const b = await account(s.app, `bob_${servers.length}${Math.floor(Math.random() * 1e6)}`);
  const lobby = await json<MatchDetail>(a, "POST", "/matches", { kind: "human-human" });
  const match = await json<MatchDetail>(b, "POST", `/matches/${lobby.id}/join`);
  return { a, b, match };
}

async function forfeit(c: TestClient, matchId: string, seat: "a" | "b", commandId = cid()) {
  const detail = await getMatch(c, matchId);
  const revision = detail.seatStates[seat]?.revision ?? 0;
  return c.request("POST", `/matches/${matchId}/seats/${seat}/forfeit`, {
    commandId,
    expectedRevision: revision,
  });
}

describe("DUEL-01 lobby, join, seat authority, same seed", () => {
  it("creates a lobby, refuses the creator/guests/third players, and starts with identical boards", async () => {
    const s = await server();
    const a = await account(s.app, "alice");
    const b = await account(s.app, "bob");
    const c = await account(s.app, "carol");
    const lobby = await json<MatchDetail>(a, "POST", "/matches", { kind: "human-human" });
    expect(lobby).toMatchObject({
      kind: "human-human",
      status: "lobby",
      rulesetVersion: "duel-v1",
    });
    const season = s.db
      .prepare("SELECT id FROM seasons WHERE ruleset_version = 'duel-v1' AND status = 'active'")
      .get() as { id: string };
    expect(lobby.season).toBe(season.id);
    expect(lobby.seats).toHaveLength(1);

    const guest = new TestClient(s.app);
    await guest.me();
    expectError(await guest.request("POST", "/matches", { kind: "human-human" }), 401, "UNAUTHENTICATED");
    expectError(await a.request("POST", `/matches/${lobby.id}/join`), 403, "FORBIDDEN"); // same account

    const listed = await json<{ items: MatchDetail[] }>(b, "GET", "/matches");
    expect(listed.items.map((m) => m.id)).toContain(lobby.id);
    const active = await json<MatchDetail>(b, "POST", `/matches/${lobby.id}/join`);
    expect(active.status).toBe("active");
    expect(active.seats.map((x) => [x.seat, x.kind])).toEqual([
      ["a", "human"],
      ["b", "human"],
    ]);
    expect(active.seatStates.a?.board).toEqual(active.seatStates.b?.board);
    expect(active.seatStates.a).not.toHaveProperty("rng");
    expectError(await c.request("POST", `/matches/${lobby.id}/join`), 404, "NOT_FOUND"); // no longer an open lobby
    expectError(await c.request("GET", `/matches/${lobby.id}`), 404, "NOT_FOUND");

    // Seat authority: each player moves only their own seat.
    const dir = legalMoves(active.seatStates.b!.board as never)[0]!;
    const wrong = await a.request("POST", `/matches/${lobby.id}/seats/b/moves`, {
      commandId: cid(),
      expectedRevision: 0,
      direction: dir,
    });
    expectError(wrong, 403, "FORBIDDEN");
    const cmd = cid();
    const first = await seatMove(b, lobby.id, "b", dir, 0, cmd);
    expect(first.changed).toBe(true);
    expect(await seatMove(b, lobby.id, "b", dir, 0, cmd)).toEqual(first); // idempotent replay
    const stale = await b.request("POST", `/matches/${lobby.id}/seats/b/moves`, {
      commandId: cid(),
      expectedRevision: 0,
      direction: dir,
    });
    expectError(stale, 409, "REVISION_CONFLICT");
    // The generic /games route never exposes another player's seat game.
    expectError(await a.request("GET", `/games/${active.seats[1]!.gameId}`), 404, "NOT_FOUND");
  });

  it("a creator can abandon an unjoined lobby", async () => {
    const s = await server();
    const a = await account(s.app, "solo");
    const lobby = await json<MatchDetail>(a, "POST", "/matches", { kind: "human-human" });
    const res = await a.request("POST", `/matches/${lobby.id}/seats/a/forfeit`, {
      commandId: cid(),
      expectedRevision: 0,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as MatchDetail).status).toBe("abandoned-lobby");
  });
});

describe("DUEL-02/03/04 terminal seats, outcome, exactly-once Elo", () => {
  it("a dead seat does not stop the other; the match finalizes once both are terminal", async () => {
    const s = await server();
    const { a, b, match } = await lobbyAndJoin(s);
    const afterA = await playSeat(a, match.id, "a");
    expect(afterA.seats[0]!.terminal).not.toBeNull();
    expect(afterA.status).toBe("active"); // seat b still plays
    const bState = afterA.seatStates.b!;
    expect(bState.status).toBe("active");
    const done = await playSeat(b, match.id, "b");
    expect(done.status).toBe("finished");
    const expected = decideDuel(
      {
        score: done.seats[0]!.score,
        maxExponent: done.seats[0]!.maxExponent,
        terminal: done.seats[0]!.terminal,
      },
      {
        score: done.seats[1]!.score,
        maxExponent: done.seats[1]!.maxExponent,
        terminal: done.seats[1]!.terminal,
      },
    );
    expect(done.outcome).toBe(expected);
    const events = ratingEvents(s, match.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.delta + events[1]!.delta).toBe(0);
    expect(done.ratingChanges).toHaveLength(2);
  }, 60_000);

  it("forfeit loses regardless of score; double forfeit is a draw with zero deltas", async () => {
    const s = await server();
    const one = await lobbyAndJoin(s);
    await playSeat(one.a, one.match.id, "a", 20);
    expect((await forfeit(one.a, one.match.id, "a")).statusCode).toBe(200);
    expect((await forfeit(one.b, one.match.id, "b")).statusCode).toBe(200);
    const drawn = await getMatch(one.a, one.match.id);
    expect(drawn).toMatchObject({ status: "finished", outcome: "draw" });
    expect(ratingEvents(s, one.match.id).map((e) => e.delta)).toEqual([0, 0]);

    const two = await lobbyAndJoin(s);
    await playSeat(two.a, two.match.id, "a", 30); // seat a scores more...
    await forfeit(two.a, two.match.id, "a"); // ...but forfeits
    await forfeit(two.b, two.match.id, "b");
    // both forfeited => draw; now a forfeit vs a finished board:
    const three = await lobbyAndJoin(s);
    await forfeit(three.a, three.match.id, "a");
    const bDone = await playSeat(three.b, three.match.id, "b");
    expect(bDone).toMatchObject({ status: "finished", outcome: "seat-b" });
    const deltas = ratingEvents(s, three.match.id);
    expect(deltas.map((e) => e.outcome)).toEqual(["0", "1"]);
    expect(deltas[0]!.delta).toBeLessThan(0);
    expect(deltas[0]!.delta + deltas[1]!.delta).toBe(0);
  }, 60_000);

  it("duplicate and concurrent finishing commands produce exactly one rating event per account", async () => {
    const s = await server();
    const { a, b, match } = await lobbyAndJoin(s);
    const ca = cid();
    const cb = cid();
    const body = (commandId: string) => ({ commandId, expectedRevision: 0 });
    const results = await Promise.all([
      a.request("POST", `/matches/${match.id}/seats/a/forfeit`, body(ca)),
      b.request("POST", `/matches/${match.id}/seats/b/forfeit`, body(cb)),
      a.request("POST", `/matches/${match.id}/seats/a/forfeit`, body(ca)),
      b.request("POST", `/matches/${match.id}/seats/b/forfeit`, body(cb)),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    // A replay after the finish returns the finished match, never a second rating.
    expect((await a.request("POST", `/matches/${match.id}/seats/a/forfeit`, body(ca))).statusCode).toBe(200);
    const events = ratingEvents(s, match.id);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.user_id)).size).toBe(2);
    const ratings = s.db.prepare("SELECT played, drawn FROM ratings").all() as {
      played: number;
      drawn: number;
    }[];
    expect(ratings).toEqual([
      { played: 1, drawn: 1 },
      { played: 1, drawn: 1 },
    ]);
    // A new seat move after the finish is refused.
    const late = await a.request("POST", `/matches/${match.id}/seats/a/moves`, {
      commandId: cid(),
      expectedRevision: 1,
      direction: "up",
    });
    expect(late.statusCode).toBe(403);
  });

  it("ratings carry over between matches in the same season (conserved integer deltas)", async () => {
    const s = await server();
    const a = await account(s.app, "carry_a");
    const b = await account(s.app, "carry_b");
    for (let i = 0; i < 2; i += 1) {
      const lobby = await json<MatchDetail>(a, "POST", "/matches", { kind: "human-human" });
      await json<MatchDetail>(b, "POST", `/matches/${lobby.id}/join`);
      // Two drawn matches (double forfeit): played +1 each, rating unchanged.
      await forfeit(b, lobby.id, "b");
      await forfeit(a, lobby.id, "a");
    }
    const lobby = await json<MatchDetail>(a, "POST", "/matches", { kind: "human-human" });
    await json<MatchDetail>(b, "POST", `/matches/${lobby.id}/join`);
    // Third match: b forfeits, a plays out => a wins +12 at equal ratings.
    await forfeit(b, lobby.id, "b");
    await playSeat(a, lobby.id, "a");
    const rows = s.db.prepare("SELECT rating, played FROM ratings ORDER BY rating DESC").all() as {
      rating: number;
      played: number;
    }[];
    expect(rows).toEqual([
      { rating: 1012, played: 3 },
      { rating: 988, played: 3 },
    ]);
  }, 60_000);
});

describe("DUEL-05 bot matches never touch human Elo", () => {
  it("human-vs-bot: the bot seat plays by itself; no rating events", async () => {
    const s = await server();
    const a = await account(s.app, "human");
    const match = await json<MatchDetail>(a, "POST", "/matches", {
      kind: "human-bot",
      bot: { strategy: "greedy-v1", nodeBudget: 4, timeBudgetMs: 1000 },
    });
    expect(match.status).toBe("active");
    expect(match.season).toBe("unrated");
    const botDone = await waitFor(
      () => getMatch(a, match.id),
      (m) => m.seats[1]!.terminal !== null,
    );
    expect(botDone.seats[1]!.acceptedMoves).toBeGreaterThan(10);
    expect(botDone.status).toBe("active"); // waits for the human; no timeout win
    await forfeit(a, match.id, "a");
    const done = await getMatch(a, match.id);
    expect(done).toMatchObject({ status: "finished", outcome: "seat-b", ratingChanges: [] });
    expect(ratingEvents(s, match.id)).toEqual([]);
    expect((s.db.prepare("SELECT COUNT(*) AS n FROM ratings").get() as { n: number }).n).toBe(0);
  }, 60_000);

  it("bot-vs-bot runs to a deterministic finish visible only to its creator", async () => {
    const s = await server();
    const a = await account(s.app, "lab_owner");
    const other = await account(s.app, "lab_other");
    const body = {
      kind: "bot-bot",
      seed: "league-seed-1",
      bots: [
        { strategy: "expectimax-v1", nodeBudget: 200, timeBudgetMs: 1000 },
        { strategy: "random-v1", nodeBudget: 1, timeBudgetMs: 1000 },
      ],
    };
    const match = await json<MatchDetail>(a, "POST", "/matches", body);
    expect(match.seed).toBe("league-seed-1");
    const done = await waitFor(
      () => getMatch(a, match.id),
      (m) => m.status === "finished",
      40_000,
    );
    expect(done.outcome).toBe("seat-a");
    expect(done.ratingChanges).toEqual([]);
    expect((await other.request("GET", `/matches/${match.id}`)).statusCode).toBe(404);
  }, 60_000);
});

describe("DB-07 restart mid-duel", () => {
  it("a human duel resumes after restart and is rated exactly once", async () => {
    const first = await startMatchServer();
    const dir = first.dir;
    const { a, b, match } = await lobbyAndJoin(first);
    await playSeat(a, match.id, "a", 15);
    const before = await getMatch(a, match.id);
    await first.close();

    const second = await server({ dir });
    const a2 = new TestClient(second.app);
    a2.cookies.set("sid", a.cookies.get("sid")!);
    await a2.me();
    const b2 = new TestClient(second.app);
    b2.cookies.set("sid", b.cookies.get("sid")!);
    await b2.me();
    const resumed = await getMatch(a2, match.id);
    expect(resumed.status).toBe("active");
    expect(resumed.seatStates.a).toEqual(before.seatStates.a);
    await forfeit(b2, match.id, "b");
    await playSeat(a2, match.id, "a");
    const done = await getMatch(a2, match.id);
    expect(done.status).toBe("finished");
    expect(ratingEvents(second, match.id)).toHaveLength(2);
  }, 60_000);

  it("bot seats re-plan after restart and finish without duplicate moves", async () => {
    const first = await startMatchServer({ botMoveDelayMs: 25 });
    const dir = first.dir;
    const a = await account(first.app, "restart_lab");
    const match = await json<MatchDetail>(a, "POST", "/matches", {
      kind: "bot-bot",
      bots: [
        { strategy: "greedy-v1", nodeBudget: 4, timeBudgetMs: 1000 },
        { strategy: "greedy-v1", nodeBudget: 4, timeBudgetMs: 1000 },
      ],
    });
    await waitFor(
      () => getMatch(a, match.id),
      (m) => m.seats.every((x) => x.acceptedMoves > 3),
    );
    await first.close();
    const second = await server({ dir, botMoveDelayMs: 0 });
    const a2 = new TestClient(second.app);
    a2.cookies.set("sid", a.cookies.get("sid")!);
    await a2.me();
    const done = await waitFor(
      () => getMatch(a2, match.id),
      (m) => m.status === "finished",
      40_000,
    );
    expect(["seat-a", "seat-b", "draw"]).toContain(done.outcome);
    for (const seat of done.seats) {
      // Every accepted move was applied exactly once and the log replays to the saved state.
      const report = second.app.services.games.verifyIntegrity(seat.gameId!);
      expect(report.ok, report.error).toBe(true);
      const rows = second.db
        .prepare("SELECT COUNT(*) AS n FROM game_moves WHERE game_id = ? AND kind = 'move'")
        .get(seat.gameId!) as { n: number };
      expect(Number(rows.n)).toBe(seat.acceptedMoves);
    }
  }, 60_000);
});

describe("seat authorization (owner:null delegation is guarded here)", () => {
  it("non-participants cannot move or forfeit a seat; nobody can drive a bot seat over HTTP", async () => {
    const s = await server();
    const { a, match } = await lobbyAndJoin(s);
    const stranger = await account(s.app, "stranger");
    const move = { commandId: cid(), expectedRevision: 0, direction: "up" };
    expectError(await stranger.request("POST", `/matches/${match.id}/seats/a/moves`, move), 404, "NOT_FOUND");
    expectError(
      await stranger.request("POST", `/matches/${match.id}/seats/b/forfeit`, {
        commandId: cid(),
        expectedRevision: 0,
      }),
      404,
      "NOT_FOUND",
    );
    const guest = new TestClient(s.app);
    await guest.me();
    expectError(
      await guest.request("POST", `/matches/${match.id}/seats/a/moves`, move),
      401,
      "UNAUTHENTICATED",
    );
    // Hot-seat: the session decides the actor; a's session cannot act for b.
    expectError(
      await a.request("POST", `/matches/${match.id}/seats/b/forfeit`, {
        commandId: cid(),
        expectedRevision: 0,
      }),
      403,
      "FORBIDDEN",
    );
    const untouched = await getMatch(a, match.id);
    expect(untouched.seats.map((x) => x.terminal)).toEqual([null, null]);

    const human = await account(s.app, "botfoe");
    const vsBot = await json<MatchDetail>(human, "POST", "/matches", {
      kind: "human-bot",
      bot: { strategy: "random-v1", nodeBudget: 1, timeBudgetMs: 1000 },
    });
    expectError(
      await human.request("POST", `/matches/${vsBot.id}/seats/b/moves`, { ...move, commandId: cid() }),
      403,
      "FORBIDDEN",
    );
    expectError(
      await human.request("POST", `/matches/${vsBot.id}/seats/b/forfeit`, {
        commandId: cid(),
        expectedRevision: 0,
      }),
      403,
      "FORBIDDEN",
    );
  }, 30_000);

  it("refuses a rated lobby with 503 when no duel season is active (seasons are seeded by backend)", async () => {
    const s = await server();
    s.db.prepare("UPDATE seasons SET status = 'archived' WHERE ruleset_version = 'duel-v1'").run();
    const a = await account(s.app, "noseason");
    const res = await a.request("POST", "/matches", { kind: "human-human" });
    expect(res.statusCode, res.body).toBe(503);
    expect((res.json() as ErrorBody).error.details).toMatchObject({ reason: "NO_ACTIVE_SEASON" });
  });
});

describe("validation", () => {
  it("rejects malformed bodies, unknown seats, and bad ids", async () => {
    const s = await server();
    const a = await account(s.app, "validator");
    expectError(await a.request("POST", "/matches", { kind: "ffa" }), 400, "VALIDATION_ERROR");
    expectError(
      await a.request("POST", "/matches", {
        kind: "human-bot",
        bot: { strategy: "llm", nodeBudget: 1, timeBudgetMs: 1 },
      }),
      400,
      "VALIDATION_ERROR",
    );
    expectError(await a.request("GET", "/matches/not-a-uuid"), 404, "NOT_FOUND");
    const lobby = await json<MatchDetail>(a, "POST", "/matches", { kind: "human-human" });
    const res = await a.request("POST", `/matches/${lobby.id}/seats/c/moves`, {
      commandId: cid(),
      expectedRevision: 0,
      direction: "up",
    });
    expectError(res, 404, "NOT_FOUND");
    const early = await a.request("POST", `/matches/${lobby.id}/seats/a/moves`, {
      commandId: cid(),
      expectedRevision: 0,
      direction: "up",
    });
    expectError(early, 409, "REVISION_CONFLICT");
  });
});
