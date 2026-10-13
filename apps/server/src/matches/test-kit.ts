// Test-only helpers for the matches/realtime suites (not imported by production code).
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { API_BASE, WS_PATH, type Direction, type MoveResponse, type WsEnvelope } from "@g2048/contracts";
import { legalMoves } from "@g2048/engine";
import { realtimePlugin, type RealtimePluginOptions } from "../realtime/plugin.js";
import { removeDir, startTestServer, TestClient, type TestServer } from "../test-support.js";
import { matchesPlugin } from "./plugin.js";
import type { MatchDetail } from "./service.js";

export type MatchServerOptions = {
  dir?: string;
  realtime?: RealtimePluginOptions;
  botMoveDelayMs?: number;
};

/** A test app with the realtime + matches plugins registered as app.ts will (see RESULT snippet). */
export async function startMatchServer(options: MatchServerOptions = {}): Promise<TestServer> {
  // Active seasons (duel-s1) are seeded by buildApp's onReady (CONTRACT-001 C18).
  const s = await startTestServer({
    ...(options.dir ? { dir: options.dir } : {}),
    allowedHosts: null,
    configure: (app) => {
      // Once app.ts registers these plugins itself (RESULT snippet), the test app reuses them.
      if (!app.hasDecorator("realtime")) void app.register(realtimePlugin, options.realtime ?? {});
      if (!app.hasDecorator("matches")) {
        void app.register(matchesPlugin, { botMoveDelayMs: options.botMoveDelayMs ?? 0 });
      }
    },
  });
  return s;
}

let counter = 0;
export function cid(prefix = "cmd"): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(8, "0")}`;
}

export async function account(app: TestServer["app"], username: string): Promise<TestClient> {
  const c = new TestClient(app);
  const res = await c.register(username);
  expect(res.statusCode, res.body).toBe(201);
  return c;
}

export async function json<T>(
  c: TestClient,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  status = method === "POST" && path === "/matches" ? 201 : 200,
): Promise<T> {
  const res = await c.request(method, path, body);
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}

export async function getMatch(c: TestClient, id: string): Promise<MatchDetail> {
  return json<MatchDetail>(c, "GET", `/matches/${id}`);
}

export async function seatMove(
  c: TestClient,
  matchId: string,
  seat: "a" | "b",
  direction: Direction,
  expectedRevision: number,
  commandId = cid(),
): Promise<MoveResponse> {
  return json<MoveResponse>(c, "POST", `/matches/${matchId}/seats/${seat}/moves`, {
    commandId,
    expectedRevision,
    direction,
  });
}

/**
 * Plays a seat with "first legal move in DIRECTIONS order" until the seat ends or `maxMoves`
 * accepted moves were made (a poor policy, so boards die quickly).
 */
export async function playSeat(
  c: TestClient,
  matchId: string,
  seat: "a" | "b",
  maxMoves = 600,
): Promise<MatchDetail> {
  let detail = await getMatch(c, matchId);
  for (let i = 0; i < maxMoves; i += 1) {
    const state = detail.seatStates[seat];
    if (!state || state.status !== "active") break;
    const direction = legalMoves(state.board)[0];
    if (!direction) break;
    await seatMove(c, matchId, seat, direction, state.revision);
    detail = await getMatch(c, matchId);
  }
  return detail;
}

export async function waitFor<T>(
  probe: () => T | Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function listen(s: TestServer): Promise<number> {
  await s.app.listen({ host: "127.0.0.1", port: 0 });
  return (s.app.server.address() as AddressInfo).port;
}

export function cookieHeader(c: TestClient): string {
  return [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

export type WsProbe = {
  socket: WebSocket;
  messages: WsEnvelope[];
  closed: Promise<{ code: number; reason: string }>;
  send(message: unknown): void;
  next(predicate: (e: WsEnvelope) => boolean, timeoutMs?: number): Promise<WsEnvelope>;
};

export async function openWs(port: number, headers: Record<string, string>): Promise<WsProbe> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { headers } as unknown as string[]);
  const messages: WsEnvelope[] = [];
  const waiters: { predicate: (e: WsEnvelope) => boolean; resolve: (e: WsEnvelope) => void }[] = [];
  socket.addEventListener("message", (event) => {
    const envelope = JSON.parse(String(event.data)) as WsEnvelope;
    messages.push(envelope);
    for (const w of [...waiters]) {
      if (w.predicate(envelope)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(envelope);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")));
  });
  return {
    socket,
    messages,
    closed,
    send: (m) => socket.send(JSON.stringify(m)),
    next(predicate, timeoutMs = 5000) {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no matching WebSocket message")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
  };
}

export function wsHeaders(
  c: TestClient,
  port: number,
  origin = `http://127.0.0.1:${port}`,
): Record<string, string> {
  return { origin, cookie: cookieHeader(c), host: `127.0.0.1:${port}` };
}

export { API_BASE, removeDir };
