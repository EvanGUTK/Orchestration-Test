import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { GameResponse, WsEnvelope } from "@g2048/contracts";
import { legalMoves } from "@g2048/engine";
import type { MatchDetail } from "../matches/service.js";
import {
  account,
  cid,
  getMatch,
  json,
  listen,
  openWs,
  removeDir,
  startMatchServer,
  wsHeaders,
} from "../matches/test-kit.js";
import { TestClient, type TestServer } from "../test-support.js";
import { RealtimeHub, WS_CLOSE, type HubSocket } from "./hub.js";

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

function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      agent: false,
      path: "/api/v1/events",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        host: `127.0.0.1:${port}`,
        ...headers,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      res.socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function soloGame(c: TestClient): Promise<GameResponse> {
  const res = await c.request("POST", "/games", { mode: "classic", seed: "ws-seed" });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as GameResponse;
}

describe("WebSocket upgrade (ACC-04)", () => {
  it("refuses foreign Origin, cross-site fetch metadata and anonymous callers before upgrading", async () => {
    const s = await server();
    const a = await account(s.app, "ws_alice");
    const port = await listen(s);
    const cookie = wsHeaders(a, port).cookie!;
    expect(await upgradeStatus(port, { origin: "http://evil.example", cookie })).toBe(403);
    expect(await upgradeStatus(port, { origin: "http://127.0.0.1:1", cookie })).toBe(403);
    expect(
      await upgradeStatus(port, {
        origin: `http://127.0.0.1:${port}`,
        cookie,
        "sec-fetch-site": "cross-site",
      }),
    ).toBe(403);
    expect(await upgradeStatus(port, { origin: `http://127.0.0.1:${port}` })).toBe(401);
    expect(await upgradeStatus(port, { origin: `http://127.0.0.1:${port}`, cookie })).toBe(101);
  });
});

describe("subscriptions, publish-after-commit and catch-up", () => {
  it("delivers own game updates, catches up by revision without duplicates", async () => {
    const s = await server();
    const a = await account(s.app, "ws_owner");
    const game = await soloGame(a);
    const port = await listen(s);

    let state = game.state;
    const moveOnce = async () => {
      const direction = legalMoves(state.board)[0]!;
      const res = await a.request("POST", `/games/${game.game.id}/moves`, {
        commandId: cid(),
        expectedRevision: state.revision,
        direction,
      });
      expect(res.statusCode, res.body).toBe(200);
      state = (res.json() as GameResponse).state;
    };
    await moveOnce();
    await moveOnce();
    await moveOnce();

    const ws = await openWs(port, wsHeaders(a, port));
    ws.send({ type: "subscribe", resource: "game", resourceId: game.game.id, lastSequence: 1 });
    await ws.next((e) => e.sequence === 3);
    expect(ws.messages.map((m) => [m.type, m.sequence])).toEqual([
      ["game.updated", 2],
      ["game.updated", 3],
    ]);
    expect(ws.messages[1]!.payload).toMatchObject({ gameId: game.game.id, revision: 3 });
    // Live events (published by GameService after COMMIT) continue the sequence.
    await moveOnce();
    await ws.next((e) => e.sequence === 4);
    expect(ws.messages.map((m) => m.sequence)).toEqual([2, 3, 4]);
    ws.socket.close();
  });

  it("refuses unauthorized subscriptions: another account, a guest, and duel seat games", async () => {
    const s = await server();
    const a = await account(s.app, "ws_victim");
    const intruder = await account(s.app, "ws_intruder");
    const b = await account(s.app, "ws_partner");
    const game = await soloGame(a);
    const lobby = await json<MatchDetail>(a, "POST", "/matches", { kind: "human-human" });
    const match = await json<MatchDetail>(b, "POST", `/matches/${lobby.id}/join`);
    const port = await listen(s);

    const other = await openWs(port, wsHeaders(intruder, port));
    other.send({ type: "subscribe", resource: "game", resourceId: game.game.id, lastSequence: 0 });
    const closed = await other.closed;
    expect(closed.code).toBe(WS_CLOSE.forbidden);
    expect(closed.reason).toMatch(/not authorized/);
    expect(other.messages).toEqual([]);

    const strangerMatch = await openWs(port, wsHeaders(intruder, port));
    strangerMatch.send({ type: "subscribe", resource: "match", resourceId: match.id, lastSequence: 0 });
    expect((await strangerMatch.closed).code).toBe(WS_CLOSE.forbidden);

    const guest = new TestClient(s.app);
    await guest.me();
    await guest.request("PATCH", "/profile", { preferences: { theme: "dark" } }); // creates the guest session
    const g = await openWs(port, wsHeaders(guest, port));
    g.send({ type: "subscribe", resource: "game", resourceId: game.game.id, lastSequence: 0 });
    expect((await g.closed).code).toBe(WS_CLOSE.forbidden);

    // Even a participant cannot subscribe to a duel seat game directly (watched via the match).
    const own = await openWs(port, wsHeaders(a, port));
    own.send({ type: "subscribe", resource: "game", resourceId: match.seats[0]!.gameId!, lastSequence: 0 });
    expect((await own.closed).code).toBe(WS_CLOSE.forbidden);
    expect(own.messages).toEqual([]);

    const runRefused = await openWs(port, wsHeaders(a, port));
    runRefused.send({
      type: "subscribe",
      resource: "bot-run",
      resourceId: "00000000-0000-4000-8000-000000000000",
      lastSequence: 0,
    });
    expect((await runRefused.closed).code).toBe(WS_CLOSE.forbidden);
  });

  it("closes the socket on malformed messages, never crashing the server", async () => {
    const s = await server();
    const a = await account(s.app, "ws_malformed");
    const port = await listen(s);
    const bad = await openWs(port, wsHeaders(a, port));
    bad.socket.send("{not json");
    expect((await bad.closed).code).toBe(WS_CLOSE.malformed);
    const unknown = await openWs(port, wsHeaders(a, port));
    unknown.send({ type: "subscribe", resource: "planet", resourceId: "x", lastSequence: 0 });
    expect((await unknown.closed).code).toBe(WS_CLOSE.malformed);
    const negative = await openWs(port, wsHeaders(a, port));
    negative.send({ type: "subscribe", resource: "game", resourceId: "x", lastSequence: -1 });
    expect((await negative.closed).code).toBe(WS_CLOSE.malformed);
    expect((await a.request("GET", "/health")).statusCode).toBeLessThan(500);
  });

  it("match events reach both players in order; reconnect catches up; after restart the client resyncs", async () => {
    const s = await server();
    const a = await account(s.app, "ws_duel_a");
    const b = await account(s.app, "ws_duel_b");
    const lobby = await json<MatchDetail>(a, "POST", "/matches", { kind: "human-human" });
    const port = await listen(s);
    const wa = await openWs(port, wsHeaders(a, port));
    wa.send({ type: "subscribe", resource: "match", resourceId: lobby.id, lastSequence: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const match = await json<MatchDetail>(b, "POST", `/matches/${lobby.id}/join`);
    // The lobby creator learns about the join (C18 match.updated).
    const joined = await wa.next((e) => e.type === "match.updated");
    expect((joined.payload as { match: MatchDetail }).match.status).toBe("active");
    const wb = await openWs(port, wsHeaders(b, port));
    wb.send({ type: "subscribe", resource: "match", resourceId: match.id, lastSequence: match.sequence });
    await new Promise((r) => setTimeout(r, 50));

    const dir = legalMoves(match.seatStates.a!.board)[0]!;
    await a.request("POST", `/matches/${match.id}/seats/a/moves`, {
      commandId: cid(),
      expectedRevision: 0,
      direction: dir,
    });
    const seen = await wb.next((e) => e.type === "match.updated");
    const seatA = (seen.payload as { match: MatchDetail }).match.seatStates.a!;
    expect(seatA.revision).toBe(1); // b sees a's board (split view) ...
    expect(seatA).not.toHaveProperty("rng"); // ... without the spawn stream

    await a.request("POST", `/matches/${match.id}/seats/a/forfeit`, {
      commandId: cid(),
      expectedRevision: 1,
    });
    await b.request("POST", `/matches/${match.id}/seats/b/forfeit`, {
      commandId: cid(),
      expectedRevision: 0,
    });
    const finalSeq = (await getMatch(a, match.id)).sequence;
    await wa.next((e) => e.sequence === finalSeq);
    await wb.next((e) => e.sequence === finalSeq);
    const seqs = (w: { messages: WsEnvelope[] }) => w.messages.map((m) => m.sequence);
    expect(seqs(wa)).toEqual(Array.from({ length: finalSeq }, (_, i) => i + 1)); // contiguous, no duplicates
    const kinds = wa.messages.map((m) => m.type).filter((t) => t !== "match.updated");
    expect(kinds).toEqual([
      "match.seat-ended",
      "match.seat-ended",
      "match.finished",
      "rating.updated",
      "rating.updated",
    ]);
    expect(seqs(wb)[0]).toBe(match.sequence + 1);

    // Reconnect with lastSequence 2: exactly the missing events, no duplicates.
    const again = await openWs(port, wsHeaders(a, port));
    again.send({ type: "subscribe", resource: "match", resourceId: match.id, lastSequence: 2 });
    await again.next((e) => e.sequence === finalSeq);
    expect(seqs(again)).toEqual(Array.from({ length: finalSeq - 2 }, (_, i) => i + 3));
    for (const w of [wa, wb, again]) w.socket.close();

    // After a restart catch-up still comes from match_events (migration 4), exactly the missing events.
    const dir2 = s.dir;
    servers.splice(servers.indexOf(s), 1);
    await s.close();
    const s2 = await server({ dir: dir2 });
    const port2 = await listen(s2);
    const a2 = new TestClient(s2.app);
    a2.cookies.set("sid", a.cookies.get("sid")!);
    await a2.me();
    const w2 = await openWs(port2, wsHeaders(a2, port2));
    w2.send({ type: "subscribe", resource: "match", resourceId: match.id, lastSequence: 1 });
    await w2.next((e) => e.sequence === finalSeq);
    expect(seqs(w2)).toEqual(Array.from({ length: finalSeq - 1 }, (_, i) => i + 2));
    expect(w2.messages.some((m) => m.type === "match.finished")).toBe(true);
    w2.socket.close();
  }, 30_000);
});

/** In-memory socket double for backpressure and heartbeat tests. */
class FakeSocket implements HubSocket {
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  terminated = false;
  pings = 0;
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }
  terminate(): void {
    this.terminated = true;
  }
  ping(): void {
    this.pings += 1;
  }
  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emitMessage(text: string): void {
    for (const l of this.listeners.get("message") ?? [])
      (l as (d: { toString(): string }, b: boolean) => void)({ toString: () => text }, false);
  }
  emitPong(): void {
    for (const l of this.listeners.get("pong") ?? []) (l as () => void)();
  }
}

describe("RealtimeHub backpressure and heartbeat", () => {
  const allowAll = {
    authorize: () => true,
    catchUp: () => ({ kind: "events" as const, events: [] }),
  };

  it("queues while the socket buffer is full and closes a slow consumer past the queue bound", async () => {
    const hub = new RealtimeHub({ outboundQueueMax: 8, highWaterBytes: 1000, heartbeatMs: 60_000 });
    const fast = new FakeSocket();
    const slow = new FakeSocket();
    hub.attach(fast, allowAll);
    hub.attach(slow, allowAll);
    for (const sock of [fast, slow]) {
      sock.emitMessage(
        JSON.stringify({ type: "subscribe", resource: "game", resourceId: "g1", lastSequence: 0 }),
      );
    }
    slow.bufferedAmount = 5000; // the client stopped reading
    for (let i = 1; i <= 8; i += 1) {
      hub.publish({ resource: "game", resourceId: "g1", type: "game.updated", sequence: i, payload: { i } });
    }
    expect(fast.sent).toHaveLength(8);
    expect(slow.sent).toHaveLength(0);
    expect(slow.closedWith).toBeNull();
    hub.publish({ resource: "game", resourceId: "g1", type: "game.updated", sequence: 9, payload: { i: 9 } });
    expect(slow.closedWith).toBe(WS_CLOSE.slowConsumer);
    expect(hub.connectionCount).toBe(1);
    // Duplicates and regressions are dropped for the healthy socket.
    hub.publish({ resource: "game", resourceId: "g1", type: "game.updated", sequence: 5, payload: {} });
    expect(fast.sent).toHaveLength(9);
    const last = JSON.parse(fast.sent.at(-1)!) as WsEnvelope;
    expect(last).toMatchObject({ protocolVersion: 1, sequence: 9 });
    await hub.close();
  });

  it("drains the queue once the buffer empties", async () => {
    const hub = new RealtimeHub({ outboundQueueMax: 50, highWaterBytes: 1000, heartbeatMs: 60_000 });
    const sock = new FakeSocket();
    hub.attach(sock, allowAll);
    sock.emitMessage(
      JSON.stringify({ type: "subscribe", resource: "match", resourceId: "m", lastSequence: 0 }),
    );
    sock.bufferedAmount = 2000;
    for (let i = 1; i <= 5; i += 1)
      hub.publish({ resource: "match", resourceId: "m", type: "match.finished", sequence: i, payload: {} });
    expect(sock.sent).toHaveLength(0);
    sock.bufferedAmount = 0;
    await new Promise((r) => setTimeout(r, 50));
    expect(sock.sent.map((t) => (JSON.parse(t) as WsEnvelope).sequence)).toEqual([1, 2, 3, 4, 5]);
    await hub.close();
  });

  it("terminates sockets that stop answering heartbeats", async () => {
    const hub = new RealtimeHub({ heartbeatMs: 20 });
    const alive = new FakeSocket();
    const dead = new FakeSocket();
    hub.attach(alive, allowAll);
    hub.attach(dead, allowAll);
    const timer = setInterval(() => alive.emitPong(), 5);
    await new Promise((r) => setTimeout(r, 120));
    clearInterval(timer);
    expect(dead.terminated).toBe(true);
    expect(alive.terminated).toBe(false);
    expect(alive.pings).toBeGreaterThan(1);
    await hub.close();
  });

  it("limits subscriptions per socket", async () => {
    const hub = new RealtimeHub({ maxSubscriptions: 2, heartbeatMs: 60_000 });
    const sock = new FakeSocket();
    hub.attach(sock, allowAll);
    for (const id of ["g1", "g2", "g2"]) {
      sock.emitMessage(
        JSON.stringify({ type: "subscribe", resource: "game", resourceId: id, lastSequence: 0 }),
      );
    }
    expect(sock.closedWith).toBeNull(); // re-subscribing an existing resource does not count
    sock.emitMessage(
      JSON.stringify({ type: "subscribe", resource: "game", resourceId: "g3", lastSequence: 0 }),
    );
    expect(sock.closedWith).toBe(WS_CLOSE.tooManySubscriptions);
    await hub.close();
  });

  it("answers a large gap with server.recovering instead of flooding", async () => {
    const hub = new RealtimeHub({ catchUpMax: 2, heartbeatMs: 60_000 });
    const sock = new FakeSocket();
    hub.attach(sock, {
      authorize: () => true,
      catchUp: () => ({
        kind: "events",
        events: [1, 2, 3].map((n) => ({
          resource: "game" as const,
          resourceId: "g",
          type: "game.updated" as const,
          sequence: n,
          payload: {},
        })),
      }),
    });
    sock.emitMessage(
      JSON.stringify({ type: "subscribe", resource: "game", resourceId: "g", lastSequence: 0 }),
    );
    expect(sock.sent.map((t) => (JSON.parse(t) as WsEnvelope).type)).toEqual(["server.recovering"]);
    await hub.close();
  });
});
