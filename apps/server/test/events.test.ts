import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { legalMoves } from "@2048/engine";
import type { GameView, MatchView, MoveResponse, WsEnvelope } from "@2048/contracts";
import { EventHub, type HubConnection } from "../src/services/hub.ts";
import { Client, cmd, startApp, until, type TestEnv } from "./helpers.ts";

type Live = TestEnv & { port: number };

async function live(env: Record<string, string> = {}): Promise<Live> {
  return (await startApp(env, undefined, { listen: true, now: () => new Date("2026-10-15T12:00:00Z") })) as Live;
}

/** HTTP client talking to the REAL listening socket, so cookies/Host/Origin are exactly what a browser would send. */
async function httpUser(t: Live, name: string): Promise<{ cookie: string; id: string; csrf: string; c: Client }> {
  const c = new Client(t.app, `http://127.0.0.1:${t.port}`);
  const r = await c.register(name);
  expect(r.status).toBe(201);
  return { cookie: `sid=${c.cookies.get("sid")}`, id: r.body.userId, csrf: r.body.csrfToken, c };
}

function open(t: Live, opts: { cookie?: string; origin?: string | null; host?: string } = {}): Promise<{ ws: WebSocket; messages: WsEnvelope[] }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin !== null) headers.origin = opts.origin ?? `http://127.0.0.1:${t.port}`;
    if (opts.host) headers.host = opts.host;
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/api/v1/events`, { headers });
    const messages: WsEnvelope[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString()) as WsEnvelope));
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", reject);
  });
}

const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => ws.once("close", (code, reason) => r({ code, reason: reason.toString() })));

describe("websocket events", { timeout: 60_000 }, () => {
  it("authenticates the session and Origin before upgrading", async () => {
    const t = await live();
    const u = await httpUser(t, "ws_auth");
    await expect(open(t, {})).rejects.toMatchObject({ status: 401 }); // no cookie
    await expect(open(t, { cookie: "sid=" + "a".repeat(43) })).rejects.toMatchObject({ status: 401 }); // bogus session
    await expect(open(t, { cookie: u.cookie, origin: "https://evil.example" })).rejects.toMatchObject({ status: 403 });
    await expect(open(t, { cookie: u.cookie, origin: null })).rejects.toMatchObject({ status: 403 }); // no Origin at all
    await expect(open(t, { cookie: u.cookie, host: "evil.example:80" })).rejects.toMatchObject({ status: 403 }); // DNS rebinding
    const ok = await open(t, { cookie: u.cookie });
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
    ok.ws.close();
    // a revoked session cannot connect
    await u.c.post("/auth/logout");
    await expect(open(t, { cookie: u.cookie })).rejects.toMatchObject({ status: 401 });
  });

  it("delivers committed game updates in sequence order to subscribed owners only", async () => {
    const t = await live();
    const a = await httpUser(t, "ws_a");
    const b = await httpUser(t, "ws_b");
    const g = (await a.c.post<GameView>("/games", { mode: "classic" })).body;
    const mine = await open(t, { cookie: a.cookie });
    const theirs = await open(t, { cookie: b.cookie });
    mine.ws.send(JSON.stringify({ type: "subscribe", resourceId: g.id, lastSequence: 0 }));
    theirs.ws.send(JSON.stringify({ type: "subscribe", resourceId: g.id, lastSequence: 0 })); // not theirs: silently ignored
    let cur = g;
    for (let i = 0; i < 4; i++) {
      const r = await a.c.post<MoveResponse>(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: cur.state.revision, direction: legalMoves(cur.state.board)[0] });
      cur = r.body.game;
    }
    await until(() => mine.messages.length, (n) => n >= 4);
    expect(mine.messages.map((m) => [m.type, m.resourceId, m.sequence, m.protocolVersion])).toEqual([1, 2, 3, 4].map((n) => ["game.updated", g.id, n, 1]));
    expect((mine.messages[3]!.payload as { game: GameView }).game.state.score).toBe(cur.state.score);
    await new Promise((r) => setTimeout(r, 150));
    expect(theirs.messages).toEqual([]);
    mine.ws.close();
    theirs.ws.close();
  });

  it("sends an authoritative catch-up snapshot on (re)subscribe and nothing newer than the client already has", async () => {
    const t = await live();
    const a = await httpUser(t, "ws_cu");
    let g = (await a.c.post<GameView>("/games", { mode: "classic" })).body;
    for (let i = 0; i < 3; i++) {
      g = (await a.c.post<MoveResponse>(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: g.state.revision, direction: legalMoves(g.state.board)[0] })).body.game;
    }
    const s1 = await open(t, { cookie: a.cookie });
    s1.ws.send(JSON.stringify({ type: "subscribe", resourceId: g.id, lastSequence: 1 }));
    await until(() => s1.messages.length, (n) => n >= 1);
    expect(s1.messages[0]).toMatchObject({ type: "game.updated", sequence: 3 });
    s1.ws.send(JSON.stringify({ type: "subscribe", resourceId: g.id, lastSequence: 3 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(s1.messages).toHaveLength(1); // already up to date => no duplicate
    s1.ws.send(JSON.stringify({ type: "unsubscribe", resourceId: g.id }));
    await a.c.post(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: 3, direction: legalMoves(g.state.board)[0] });
    await new Promise((r) => setTimeout(r, 150));
    expect(s1.messages).toHaveLength(1);
    s1.ws.close();
  });

  it("does not publish events for rolled-back commands or no-ops", async () => {
    const t = await live();
    const a = await httpUser(t, "ws_rb");
    const g = (await a.c.post<GameView>("/games", { mode: "classic" })).body;
    const sock = await open(t, { cookie: a.cookie });
    sock.ws.send(JSON.stringify({ type: "subscribe", resourceId: g.id, lastSequence: 0 }));
    await new Promise((r) => setTimeout(r, 100));
    // stale revision => rejected, nothing published
    const stale = await a.c.post(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: 7, direction: "left" });
    expect(stale.status).toBe(409);
    // sabotage persistence => 500 + rollback, nothing published
    t.db.raw.prepare(
      "INSERT INTO game_moves (game_id, revision, command_id, kind, direction, accepted_moves, events_json, checksum, created_at) VALUES (?, 1, 'x', 'move', 'up', 1, '[]', ?, 't')",
    ).run(g.id, "a".repeat(64));
    const boom = await a.c.post(`/games/${g.id}/moves`, { commandId: cmd(), expectedRevision: 0, direction: legalMoves(g.state.board)[0] });
    expect(boom.status).toBe(500);
    await new Promise((r) => setTimeout(r, 150));
    expect(sock.messages).toEqual([]);
    sock.ws.close();
  });

  it("closes malformed, binary and over-subscribing clients explicitly", async () => {
    const t = await live();
    const a = await httpUser(t, "ws_bad");
    const s1 = await open(t, { cookie: a.cookie });
    const c1 = closed(s1.ws);
    s1.ws.send("not json");
    expect((await c1).code).toBe(1003);
    const s2 = await open(t, { cookie: a.cookie });
    const c2 = closed(s2.ws);
    s2.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect((await c2).code).toBe(1003);
    const s3 = await open(t, { cookie: a.cookie });
    const c3 = closed(s3.ws);
    s3.ws.send(JSON.stringify({ type: "subscribe", resourceId: "x".repeat(300), lastSequence: 0 }));
    expect((await c3).code).toBe(1003);
    // oversized frames are cut off by the transport limit
    const s4 = await open(t, { cookie: a.cookie });
    const c4 = closed(s4.ws);
    s4.ws.send("x".repeat(40_000));
    expect((await c4).code).toBe(1009);
    s4.ws.close();
  });

  it("allows 100 subscriptions per connection and ends the connection at the 101st", async () => {
    const t = await live({ MAX_ACTIVE_GAMES: "200" });
    const a = await httpUser(t, "ws_many");
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push((await a.c.post<GameView>("/games", { mode: "classic" })).body.id);
    const sock = await open(t, { cookie: a.cookie });
    for (const id of ids.slice(0, 100)) sock.ws.send(JSON.stringify({ type: "subscribe", resourceId: id, lastSequence: 99 }));
    await new Promise((r) => setTimeout(r, 300));
    expect(sock.ws.readyState).toBe(WebSocket.OPEN);
    const end = closed(sock.ws);
    sock.ws.send(JSON.stringify({ type: "subscribe", resourceId: ids[100], lastSequence: 99 }));
    expect((await end).code).toBe(1008);
  });

  it("streams match events to seats and rating.updated to the rated accounts", async () => {
    const t = await live();
    const a = await httpUser(t, "ws_duel_a");
    const b = await httpUser(t, "ws_duel_b");
    const sa = await open(t, { cookie: a.cookie });
    const sb = await open(t, { cookie: b.cookie });
    const m = (await a.c.post<MatchView>("/matches", { kind: "human-vs-human" })).body;
    const j = (await b.c.post<MatchView>(`/matches/${m.id}/join`)).body;
    const [ga, gb] = [j.seats[0].gameId!, j.seats[1]!.gameId!];
    const finish = async (c: Client, id: string, score: string) => {
      t.db.raw.prepare("UPDATE games SET accepted_moves = 499, revision = 499, score = ? WHERE id = ?").run(score, id);
      const fresh = (await c.get<GameView>(`/games/${id}`)).body;
      await c.post(`/games/${id}/moves`, { commandId: cmd(), expectedRevision: 499, direction: legalMoves(fresh.state.board)[0] });
    };
    await finish(a.c, ga, "900");
    await finish(b.c, gb, "100");
    await until(() => [sa.messages.length, sb.messages.length], ([x, y]) => x! >= 3 && y! >= 3);
    const typesA = sa.messages.map((e) => e.type);
    expect(typesA).toContain("match.seat-ended");
    expect(typesA).toContain("match.finished");
    expect(typesA.filter((x) => x === "rating.updated")).toHaveLength(1);
    const ratingA = sa.messages.find((e) => e.type === "rating.updated")!;
    expect(ratingA.payload).toMatchObject({ event: { accountId: a.id, delta: 12, outcome: 1 } });
    expect((sb.messages.find((e) => e.type === "rating.updated")!.payload as { event: { delta: number } }).event.delta).toBe(-12);
    // sequences per resource never regress
    for (const msgs of [sa.messages, sb.messages]) {
      const last = new Map<string, number>();
      for (const e of msgs) {
        expect(e.sequence).toBeGreaterThan(last.get(e.resourceId) ?? 0);
        last.set(e.resourceId, e.sequence);
      }
    }
    sa.ws.close();
    sb.ws.close();
  });
});

describe("event hub backpressure", () => {
  function fake(buffered: number): HubConnection & { sent: string[]; closed: [number, string][] } {
    const sent: string[] = [];
    const closedWith: [number, string][] = [];
    return {
      id: 1, accountId: "acct", subscriptions: new Set(), sent, closed: closedWith,
      buffered: () => buffered, send: (s) => void sent.push(s), close: (c, r) => void closedWith.push([c, r]),
    };
  }
  const env = (n: number): WsEnvelope => ({ protocolVersion: 1, type: "game.updated", resourceId: "g1", sequence: n, payload: {} });

  it("disconnects a slow consumer explicitly instead of buffering without bound", () => {
    const hub = new EventHub({ maxBufferedBytes: 1000 });
    const fast = fake(10);
    const slow = fake(5000);
    hub.add(fast);
    hub.add(slow);
    hub.subscribe(fast, "g1");
    hub.subscribe(slow, "g1");
    hub.publish([{ envelope: env(1) }]);
    expect(fast.sent).toHaveLength(1);
    expect(slow.sent).toHaveLength(0);
    expect(slow.closed).toEqual([[1013, "slow consumer"]]);
    expect(hub.size).toBe(1);
    expect(hub.slowConsumersDropped).toBe(1);
    hub.publish([{ envelope: env(2) }]);
    expect(fast.sent).toHaveLength(2);
    expect(slow.closed).toHaveLength(1); // not closed again
  });

  it("bounds subscriptions per connection and routes account-targeted events without a subscription", () => {
    const hub = new EventHub({ maxSubscriptionsPerConnection: 2 });
    const c = fake(0);
    hub.add(c);
    expect(hub.subscribe(c, "a")).toBe(true);
    expect(hub.subscribe(c, "b")).toBe(true);
    expect(hub.subscribe(c, "a")).toBe(true);
    expect(hub.subscribe(c, "c")).toBe(false);
    hub.publish([{ envelope: { ...env(1), resourceId: "unsubscribed" }, accounts: ["acct"] }]);
    expect(c.sent).toHaveLength(1);
    hub.remove(c);
    hub.publish([{ envelope: env(2), accounts: ["acct"] }]);
    expect(c.sent).toHaveLength(1);
  });
});
