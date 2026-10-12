/**
 * Server authority vs the independent oracle (ACC/SOLO/DB/RANK mapping in tests/acceptance/PLAN.md):
 * SOLO-01/02, ENG-03, ENG-04 (through the API), DB-03 duplicate command, DB-04 stale clients, RANK-04 (server derives state).
 * Boots the production entry on loopback with a private temp DB. Skipped LOUDLY when the server is not in this checkout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, newCommandId, type Dir } from "../acceptance/support/client.ts";
import { serverAvailable, startServer, type ServerHandle } from "../acceptance/support/server-process.ts";
import { OracleGame, canonicalOfServerState, practiceRules, unwrapGame } from "./support/game-driver.ts";
import type { OState } from "./oracle/game.ts";

const available = serverAvailable();
if (!available) console.warn("api-authority SKIPPED: apps/server/src/main.ts is not in this checkout (not a pass)");

type GameViewLite = { id: string; mode: string; rulesetVersion: string; state: OState; seed: string | null };
type MoveRes = { game: GameViewLite; changed: boolean; scoreDelta: string; sequence: number };

describe.skipIf(!available)("server authority vs oracle", () => {
  let server: ServerHandle;
  let client: ApiClient;

  beforeAll(async () => {
    server = await startServer();
    client = new ApiClient(server.baseUrl);
    const r = await client.registerAndLogin(`q_${Date.now().toString(36)}`);
    expect(r.status, r.raw).toBeLessThan(300);
  });
  afterAll(async () => {
    await server?.stop();
  });

  async function create(boardSize: number, seed: string, spawnFourTenths = 1) {
    const r = await client.post("/games", { mode: "practice", custom: { boardSize, seed, spawnFourTenths } });
    expect(r.status, r.raw).toBe(201 === r.status ? 201 : 200);
    return unwrapGame<GameViewLite>(r.body);
  }

  it("created practice game equals the oracle initial state (seeded, ENG-04/SOLO-02)", async () => {
    const g = await create(6, "api-seed-1");
    const o = new OracleGame(practiceRules(6), "api-seed-1");
    expect(g.rulesetVersion).toBe(o.rules.version);
    expect(canonicalOfServerState(g.state)).toBe(o.canonical());
  });

  it("120 server moves match the oracle byte-for-byte; no-op leaves revision/PRNG/score untouched (ENG-03)", async () => {
    const g = await create(8, "api-seed-2");
    const o = new OracleGame(practiceRules(8), "api-seed-2");
    let rev = g.state.revision;
    for (let i = 0; i < 120; i++) {
      if (i % 15 === 7) {
        const bad = o.illegalDirection();
        if (bad) {
          const before = o.canonical();
          const r = await client.post<MoveRes>(`/games/${g.id}/moves`, { commandId: newCommandId(), expectedRevision: rev, direction: bad });
          expect(r.status, r.raw).toBe(200);
          expect(r.body.changed).toBe(false);
          expect(canonicalOfServerState(r.body.game.state)).toBe(before);
        }
      }
      const dir = o.nextDirection()!;
      o.apply(dir);
      const r = await client.post<MoveRes>(`/games/${g.id}/moves`, { commandId: newCommandId(), expectedRevision: rev, direction: dir });
      expect(r.status, r.raw).toBe(200);
      expect(r.body.changed).toBe(true);
      expect(canonicalOfServerState(r.body.game.state), `move ${i}`).toBe(o.canonical());
      rev = r.body.game.state.revision;
    }
    const fresh = await client.get<GameViewLite>(`/games/${g.id}`);
    expect(canonicalOfServerState(unwrapGame<GameViewLite>(fresh.body).state)).toBe(o.canonical());
  });

  it("duplicate commandId returns the identical result with one move; different payload conflicts (DB-03)", async () => {
    const g = await create(8, "api-seed-3");
    const o = new OracleGame(practiceRules(8), "api-seed-3");
    const dir = o.nextDirection() as Dir;
    const cmd = { commandId: newCommandId(), expectedRevision: g.state.revision, direction: dir };
    const a = await client.post<MoveRes>(`/games/${g.id}/moves`, cmd);
    const b = await client.post<MoveRes>(`/games/${g.id}/moves`, cmd);
    expect(a.status).toBe(200);
    expect(b.status, b.raw).toBe(200);
    expect(canonicalOfServerState(b.body.game.state)).toBe(canonicalOfServerState(a.body.game.state));
    expect(b.body.game.state.acceptedMoves).toBe(1);
    const other = (["up", "right", "down", "left"] as Dir[]).find((d) => d !== dir)!;
    const c = await client.post<{ error: { code: string } }>(`/games/${g.id}/moves`, { ...cmd, direction: other });
    expect(c.status, c.raw).toBe(409);
    expect(c.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const now = unwrapGame<GameViewLite>((await client.get(`/games/${g.id}`)).body);
    expect(now.state.acceptedMoves).toBe(1);
  });

  it("two stale clients: exactly one accepted, other REVISION_CONFLICT, no double spawn (DB-04)", async () => {
    const g = await create(8, "api-seed-4");
    const o = new OracleGame(practiceRules(8), "api-seed-4");
    const dir = o.nextDirection() as Dir;
    o.apply(dir);
    const rev = g.state.revision;
    const [x, y] = await Promise.all([
      client.clone().post<MoveRes & { error?: { code: string } }>(`/games/${g.id}/moves`, { commandId: newCommandId("a"), expectedRevision: rev, direction: dir }),
      client.clone().post<MoveRes & { error?: { code: string } }>(`/games/${g.id}/moves`, { commandId: newCommandId("b"), expectedRevision: rev, direction: dir }),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses, `${x.raw} | ${y.raw}`).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.body.error?.code).toBe("REVISION_CONFLICT");
    const now = unwrapGame<GameViewLite>((await client.get(`/games/${g.id}`)).body);
    expect(canonicalOfServerState(now.state)).toBe(o.canonical());
  });

  it("invalid custom sizes are rejected with VALIDATION_ERROR and no game is created (SOLO-02)", async () => {
    for (const boardSize of [2, 9, 0, -1, 4.5]) {
      const r = await client.post<{ error: { code: string; requestId: string } }>("/games", { mode: "practice", custom: { boardSize, seed: "x" } });
      expect(r.status, `size ${boardSize}: ${r.raw}`).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION_ERROR");
      expect(typeof r.body.error.requestId).toBe("string");
      expect(r.raw).not.toMatch(/\bat .*\.(ts|js):\d+/); // no stack traces
    }
  });
});
