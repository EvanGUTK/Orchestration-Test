import { RULESETS, practiceRuleset } from "@g2048/contracts";
import type {
  Direction,
  GameMode,
  GameResponse,
  GameState,
  GameSummary,
  MeResponse,
  MoveResponse,
  Preferences,
  PublicUser,
  Ruleset,
} from "@g2048/contracts";
import { applyMove, maxExponent, newGame } from "@g2048/engine";

/**
 * In-memory stand-in for the CONTRACT-001 HTTP API, used as a mocked `fetch` in tests. Game transitions
 * use the real engine. Models CSRF, idempotent commandIds, optimistic revisions, and injectable faults
 * (dropped responses after commit, DB_BUSY, network outages, external moves from "another tab").
 */
type Game = {
  id: string;
  mode: GameMode;
  rules: Ruleset;
  state: GameState;
  history: GameState[];
  createdAt: string;
  updatedAt: string;
};

export type FakeServer = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly requests: Array<{
    method: string;
    path: string;
    body: unknown;
    csrf: string | null;
    credentials?: RequestCredentials;
  }>;
  /** Moves the server actually applied (changed), per game, in order. */
  readonly applied: Map<string, Direction[]>;
  games: Map<string, Game>;
  user: PublicUser | null;
  preferences: Preferences;
  password: string;
  faults: {
    /** Next N requests fail with a network error before reaching the server. */
    networkDownFor: number;
    /** Network fails for everything until set false. */
    offline: boolean;
    /** Next N move requests are committed, then the response is lost (network error). */
    dropResponseAfterCommit: number;
    /** Next N move requests fail with 503 DB_BUSY before committing. */
    dbBusy: number;
    /** Next login attempts are rate limited for this many seconds. */
    rateLimitSeconds: number;
    /** Respond 401 to game requests (session revoked). */
    unauthenticated: boolean;
  };
  /** Applies a move as if from another tab (bumps revision without the client knowing). */
  externalMove(gameId: string, direction: Direction): void;
  seedGame(state: GameState, mode?: GameMode): string;
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let requestCounter = 0;
const error = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message, requestId: `req-${++requestCounter}` } }, headers);

export function createFakeServer(options: { user?: PublicUser | null; password?: string } = {}): FakeServer {
  let csrf = "csrf-guest-1";
  let rotation = 1;
  let gameCounter = 0;
  const commands = new Map<string, { hash: string; status: number; body: unknown }>();
  const server: FakeServer = {
    requests: [],
    applied: new Map(),
    games: new Map(),
    user: options.user ?? null,
    preferences: {},
    password: options.password ?? "correct horse battery",
    faults: {
      networkDownFor: 0,
      offline: false,
      dropResponseAfterCommit: 0,
      dbBusy: 0,
      rateLimitSeconds: 0,
      unauthenticated: false,
    },
    externalMove(gameId, direction) {
      const g = server.games.get(gameId)!;
      const r = applyMove(g.state, direction, g.rules);
      if (r.changed) {
        g.history.push(g.state);
        g.state = r.state;
      }
    },
    seedGame(state, mode = "classic") {
      const id = `g${++gameCounter}`;
      const rules =
        mode === "practice"
          ? practiceRuleset({ size: state.board.size, fourWeight: 1, undo: true })
          : RULESETS["classic-v1"];
      server.games.set(id, {
        id,
        mode,
        rules,
        state,
        history: [],
        createdAt: "2026-10-12T00:00:00Z",
        updatedAt: "2026-10-12T00:00:00Z",
      });
      return id;
    },
    fetch: async (input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const url = new URL(input, "http://127.0.0.1");
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      server.requests.push({
        method,
        path,
        body,
        csrf: headers.get("x-csrf-token"),
        credentials: init.credentials,
      });
      if (server.faults.offline) throw new TypeError("Failed to fetch");
      if (server.faults.networkDownFor > 0) {
        server.faults.networkDownFor--;
        throw new TypeError("Failed to fetch");
      }
      const mutating = method !== "GET";
      if (mutating && headers.get("x-csrf-token") !== csrf)
        return error(403, "FORBIDDEN", "CSRF check failed");

      const me = (): MeResponse => ({
        user: server.user,
        guest: server.user ? null : { id: "guest-1" },
        csrfToken: csrf,
        preferences: server.user ? server.preferences : {},
      });
      const summary = (g: Game): GameSummary => ({
        id: g.id,
        mode: g.mode,
        rulesetVersion: g.rules.version,
        status: g.state.status,
        score: g.state.score,
        maxExponent: maxExponent(g.state.board),
        acceptedMoves: g.state.acceptedMoves,
        revision: g.state.revision,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      });
      const gameResponse = (g: Game): GameResponse => ({
        game: summary(g),
        state: g.state,
        canUndo: g.rules.undo && g.history.length > 0 && g.state.status === "active",
      });

      if (path === "/auth/me" && method === "GET") return json(200, me());
      if (path === "/auth/login") {
        if (server.faults.rateLimitSeconds > 0) {
          return error(429, "RATE_LIMITED", "Too many attempts", {
            "retry-after": String(server.faults.rateLimitSeconds),
          });
        }
        const b = body as { username: string; password: string };
        if (b.username !== "ada" || b.password !== server.password) {
          return error(401, "UNAUTHENTICATED", "Invalid credentials");
        }
        server.user = { id: "u1", username: "ada", displayName: "Ada", createdAt: "2026-10-01T00:00:00Z" };
        csrf = `csrf-account-${++rotation}`;
        return json(200, me());
      }
      if (path === "/auth/register") {
        const b = body as { username: string; displayName: string };
        server.user = {
          id: "u2",
          username: b.username,
          displayName: b.displayName,
          createdAt: "2026-10-12T00:00:00Z",
        };
        csrf = `csrf-account-${++rotation}`;
        return json(201, me());
      }
      if (path === "/auth/logout") {
        server.user = null;
        csrf = `csrf-guest-${++rotation}`;
        return json(200, {
          ok: true,
          revokedSessions: (body as { allSessions?: boolean })?.allSessions ? 3 : 1,
        });
      }
      if (path === "/auth/password") {
        const b = body as { currentPassword: string; newPassword: string };
        if (b.currentPassword !== server.password)
          return error(401, "UNAUTHENTICATED", "Invalid credentials");
        server.password = b.newPassword;
        return json(200, { ok: true, revokedSessions: 2 });
      }
      if (path === "/profile" && method === "PATCH") {
        if (!server.user) return error(401, "UNAUTHENTICATED", "Sign in");
        const b = body as { displayName?: string; preferences?: Preferences };
        if (b.displayName) server.user = { ...server.user, displayName: b.displayName };
        if (b.preferences) server.preferences = { ...server.preferences, ...b.preferences };
        return json(200, me());
      }

      if (path.startsWith("/games")) {
        if (server.faults.unauthenticated || !server.user) return error(401, "UNAUTHENTICATED", "Sign in");
        if (path === "/games" && method === "POST") {
          const b = body as
            | { mode: "classic" }
            | {
                mode: "practice";
                practice: { size: number; fourWeight: number; undo: boolean; seed?: string };
              };
          const rules = b.mode === "practice" ? practiceRuleset(b.practice) : RULESETS["classic-v1"];
          const seed =
            b.mode === "practice" && b.practice.seed ? b.practice.seed : `server-seed-${gameCounter}`;
          const id = server.seedGame(newGame(rules, seed), b.mode);
          server.games.get(id)!.rules = rules;
          return json(201, gameResponse(server.games.get(id)!));
        }
        if (path === "/games" && method === "GET") {
          const all = [...server.games.values()].reverse();
          const start = url.searchParams.get("cursor") ? Number(url.searchParams.get("cursor")) : 0;
          const limit = Number(url.searchParams.get("limit") ?? "25");
          const items = all.slice(start, start + limit).map(summary);
          const next = start + limit < all.length ? String(start + limit) : null;
          return json(200, { items, nextCursor: next });
        }
        const m = /^\/games\/([^/]+)(?:\/(moves|undo|forfeit))?$/.exec(path);
        const g = m ? server.games.get(decodeURIComponent(m[1]!)) : undefined;
        if (!m || !g) return error(404, "NOT_FOUND", "Not found");
        if (!m[2] && method === "GET") return json(200, gameResponse(g));

        const b = body as { commandId: string; expectedRevision: number; direction?: Direction };
        const key = `${g.id}:${b.commandId}`;
        const hash = JSON.stringify([m[2], b.direction ?? null, b.expectedRevision]);
        const stored = commands.get(key);
        if (stored) {
          if (stored.hash !== hash) return error(409, "IDEMPOTENCY_CONFLICT", "commandId reused");
          return json(stored.status, stored.body);
        }
        if (m[2] === "moves" && server.faults.dbBusy > 0) {
          server.faults.dbBusy--;
          return error(503, "DB_BUSY", "The database is busy", { "retry-after": "1" });
        }
        if (b.expectedRevision !== g.state.revision) return error(409, "REVISION_CONFLICT", "Stale revision");

        let status = 200;
        let response: unknown;
        if (m[2] === "moves") {
          const r = applyMove(g.state, b.direction!, g.rules);
          if (r.changed) {
            g.history.push(g.state);
            g.state = r.state;
            const list = server.applied.get(g.id) ?? [];
            list.push(b.direction!);
            server.applied.set(g.id, list);
          }
          const res: MoveResponse = r.changed
            ? { changed: true, scoreDelta: r.scoreDelta, state: r.state, events: [...r.events] }
            : { changed: false, scoreDelta: "0", state: g.state, events: [], code: "NO_CHANGE" };
          response = res;
        } else if (m[2] === "undo") {
          const prev = g.history.pop();
          if (!prev) return error(409, "REVISION_CONFLICT", "Nothing to undo");
          g.state = { ...prev, revision: g.state.revision + 1 };
          response = gameResponse(g);
        } else {
          g.state = { ...g.state, status: "forfeited", revision: g.state.revision + 1 };
          response = gameResponse(g);
        }
        commands.set(key, { hash, status, body: response });
        if (m[2] === "moves" && server.faults.dropResponseAfterCommit > 0) {
          server.faults.dropResponseAfterCommit--;
          throw new TypeError("Failed to fetch (response lost)");
        }
        status = 200;
        return json(status, response);
      }
      return error(404, "NOT_FOUND", "Not found");
    },
  };
  return server;
}

export const ADA: PublicUser = {
  id: "u1",
  username: "ada",
  displayName: "Ada",
  createdAt: "2026-10-01T00:00:00Z",
};
