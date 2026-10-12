/**
 * DB-02 / OPS-08 (game half): SIGKILL the production server while a burst of moves is in flight, restart it on the
 * SAME database file, and assert the recovered game is exactly some prefix of the accepted move stream:
 *   - state === oracle replay of the recorded event directions (no partial score / spawn / PRNG advance),
 *   - revision === acceptedMoves === number of recorded move events (no gaps),
 *   - every move the client saw acknowledged is durable,
 *   - an acknowledged commandId is idempotent after restart, SQLite integrity_check is "ok".
 * Skipped LOUDLY when the server is not in this checkout.
 */
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, newCommandId, type Dir } from "../acceptance/support/client.ts";
import { serverAvailable, startServer, type ServerHandle } from "../acceptance/support/server-process.ts";
import { OracleGame, canonicalOfServerState, practiceRules, unwrapGame } from "./support/game-driver.ts";
import type { OState } from "./oracle/game.ts";

const available = serverAvailable();
if (!available) console.warn("fault-kill-during-move SKIPPED: apps/server/src/main.ts is not in this checkout (not a pass)");

type GameViewLite = { id: string; state: OState };
type EventsPage = { events: { sequence: number; direction: Dir }[]; nextCursor: number | null };
type MoveRes = { game: GameViewLite; changed: boolean };

async function allEvents(c: ApiClient, id: string) {
  const out: { sequence: number; direction: Dir }[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const r: Awaited<ReturnType<typeof c.get<EventsPage>>> = await c.get<EventsPage>(`/games/${id}/events?after=${cursor}&limit=100`);
    expect(r.status, r.raw).toBe(200);
    out.push(...r.body.events);
    cursor = r.body.nextCursor;
  }
  return out;
}

describe.skipIf(!available)("kill during move burst, restart, verify atomic recovery", () => {
  let server: ServerHandle;
  const username = `fault_${Date.now().toString(36)}`;
  const password = "correct horse battery staple 9";

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  for (let round = 0; round < 4; round++) {
    it(`round ${round}: crash with ${8 + round * 4} in-flight moves`, async () => {
      let client = new ApiClient(server.baseUrl);
      const reg = await client.registerAndLogin(`${username}_${round}`, password);
      expect(reg.status, reg.raw).toBeLessThan(300);
      const seed = `fault-seed-${round}`;
      const created = await client.post("/games", { mode: "practice", custom: { boardSize: 8, seed } });
      expect(created.status, created.raw).toBeLessThan(300);
      const g = unwrapGame<GameViewLite>(created.body);

      const oracle = new OracleGame(practiceRules(8), seed);
      let rev = g.state.revision;
      const acked: { commandId: string; revision: number }[] = [];
      // Sequential prefix so the oracle knows the exact stream, then a parallel burst + SIGKILL.
      const prefix = 15 + round * 7;
      for (let i = 0; i < prefix; i++) {
        const d = oracle.nextDirection()!;
        oracle.apply(d);
        const commandId = newCommandId();
        const r = await client.post<MoveRes>(`/games/${g.id}/moves`, { commandId, expectedRevision: rev, direction: d });
        expect(r.status, r.raw).toBe(200);
        rev = r.body.game.state.revision;
        acked.push({ commandId, revision: rev });
      }
      const burst = 8 + round * 4;
      const inflight: Promise<{ status: number; commandId: string; revision?: number } | null>[] = [];
      for (let i = 0; i < burst; i++) {
        const d = oracle.nextDirection() ?? "up";
        // all burst commands reuse the same expectedRevision (as stale/racing clients would); at most one may win
        const commandId = newCommandId("burst");
        inflight.push(
          client
            .clone()
            .post<MoveRes>(`/games/${g.id}/moves`, { commandId, expectedRevision: rev, direction: d })
            .then((r) => ({ status: r.status, commandId, revision: r.body?.game?.state?.revision }))
            .catch(() => null),
        );
      }
      await new Promise((r) => setTimeout(r, round * 3)); // vary the kill point relative to the burst
      await server.kill("SIGKILL");
      const settled = await Promise.all(inflight);
      for (const s of settled) if (s && s.status === 200 && s.revision !== undefined) acked.push({ commandId: s.commandId, revision: s.revision });

      await server.restart();
      client = new ApiClient(server.baseUrl);
      const login = await client.post("/auth/login", { username: `${username}_${round}`, password });
      expect(login.status, login.raw).toBeLessThan(300);
      client.csrfToken = (login.body as { csrfToken?: string }).csrfToken ?? null;

      const after = unwrapGame<GameViewLite>((await client.get(`/games/${g.id}`)).body);
      const events = await allEvents(client, g.id);
      // 1. no gaps, counters agree
      expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
      expect(after.state.revision).toBe(events.length);
      expect(after.state.acceptedMoves).toBe(events.length);
      // 2. state is exactly the oracle replay of the recorded directions (whole transaction or nothing)
      const replay = new OracleGame(practiceRules(8), seed);
      for (const e of events) {
        const r = replay.apply(e.direction);
        expect(r.changed, `recorded event ${e.sequence} must be a changed move`).toBe(true);
      }
      expect(canonicalOfServerState(after.state)).toBe(replay.canonical());
      // 3. everything that was acknowledged before the crash survived
      const maxAcked = Math.max(0, ...acked.map((a) => a.revision));
      expect(after.state.revision).toBeGreaterThanOrEqual(maxAcked);
      // 4. at most one burst command could win (they all raced on the same expectedRevision)
      expect(after.state.revision).toBeLessThanOrEqual(prefix + 1);
      // 5. an acknowledged command stays idempotent across restart
      const last = acked.filter((a) => a.revision === prefix)[0];
      if (last) {
        const dup = events[prefix - 1]!;
        const r = await client.post<MoveRes>(`/games/${g.id}/moves`, { commandId: last.commandId, expectedRevision: prefix - 1, direction: dup.direction });
        expect(r.status, r.raw).toBe(200);
        expect(r.body.game.state.acceptedMoves).toBeGreaterThanOrEqual(prefix);
      }
      // 6. the database file passes integrity_check and foreign_key_check (read-only second connection)
      const db = new DatabaseSync(server.dbPath, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    });
  }
});
