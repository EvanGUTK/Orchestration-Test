/**
 * OPS-05: 100,000-event history; p95 seek < 250 ms using snapshots; every seek lands on the oracle-exact state.
 * Build: drive one 8x8 practice game through the API until the server reports >= 100,000 domain events, then
 * time `seek(s)` = fetch events after the nearest snapshot <= s + apply them. Snapshots come from GET /replays/:id.
 * Runs against a private server/DB. Skipped LOUDLY when the server is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, newCommandId, type Dir } from "../acceptance/support/client.ts";
import { serverAvailable, startServer, type ServerHandle } from "../acceptance/support/server-process.ts";
import { OracleGame, canonicalOfServerState, practiceRules, unwrapGame } from "../integration/support/game-driver.ts";
import type { OState } from "../integration/oracle/game.ts";
import { summarize, writeReport } from "./support/stats.ts";

const EVENT_TARGET = Number(process.env.OPS05_EVENTS ?? 100_000);
const available = serverAvailable();
if (!available) console.warn("OPS-05 SKIPPED: apps/server/src/main.ts is not in this checkout (not a pass)");

type View = { id: string; state: OState };
type EvPage = { events: { sequence: number; direction: Dir; events: unknown[] }[]; nextCursor: number | null };
type ReplayLite = { snapshots: { sequence: number; checksum: string; state: OState }[]; moves: unknown[] };

describe.skipIf(!available)("OPS-05 replay seek over 100k events", () => {
  let server: ServerHandle;
  beforeAll(async () => {
    server = await startServer({ timeoutMs: 60_000 });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("p95 seek < 250 ms with snapshots; seeks are oracle-exact", async () => {
    const c = new ApiClient(server.baseUrl);
    expect((await c.registerAndLogin(`ops5_${Date.now().toString(36)}`)).status).toBeLessThan(300);
    const seed = "ops05-seed";
    const g = unwrapGame<View>((await c.post("/games", { mode: "practice", custom: { boardSize: 8, seed } })).body);
    const oracle = new OracleGame(practiceRules(8), seed);
    let rev = g.state.revision;
    // Domain events per move are counted from the server's own event pages (incrementally), not guessed.
    let eventCount = 0;
    let eventCursor = 0;
    const drain = async () => {
      let cur: number | null = eventCursor;
      while (cur !== null) {
        const pg: Awaited<ReturnType<typeof c.get<EvPage>>> = await c.get<EvPage>(`/games/${g.id}/events?after=${cur}&limit=100`);
        expect(pg.status, pg.raw).toBe(200);
        for (const e of pg.body.events) {
          eventCount += e.events.length;
          eventCursor = Math.max(eventCursor, e.sequence);
        }
        cur = pg.body.nextCursor;
      }
    };
    while (eventCount < EVENT_TARGET) {
      const d = oracle.nextDirection();
      if (!d) break; // dead board before the target: reported via the assertion below
      oracle.apply(d);
      const r = await c.post<{ game: View }>(`/games/${g.id}/moves`, { commandId: newCommandId(), expectedRevision: rev, direction: d });
      expect(r.status, r.raw).toBe(200);
      rev = r.body.game.state.revision;
      if (oracle.moves.length % 500 === 0) await drain();
    }
    await drain();
    expect(eventCount, "history must reach the event target before the board dies").toBeGreaterThanOrEqual(EVENT_TARGET);
    const history = oracle.moves.length;
    const replayRes = await c.get<ReplayLite>(`/replays/${g.id}`);
    expect(replayRes.status, replayRes.raw).toBe(200);
    const snaps = replayRes.body.snapshots;
    expect(snaps.length).toBeGreaterThanOrEqual(Math.floor(history / 50));

    const samples: number[] = [];
    const bad: string[] = [];
    const targets = Array.from({ length: 220 }, (_, i) => 1 + ((i * 7919 + 13) % history));
    for (const [i, target] of targets.entries()) {
      const t0 = performance.now();
      const snap = [...snaps].reverse().find((s) => s.sequence <= target);
      const startSeq = snap?.sequence ?? 0;
      const evs: { sequence: number; direction: Dir }[] = [];
      let cur: number | null = startSeq;
      while (cur !== null && evs.length < target - startSeq) {
        const pg: Awaited<ReturnType<typeof c.get<EvPage>>> = await c.get<EvPage>(`/games/${g.id}/events?after=${cur}&limit=${Math.max(1, target - startSeq)}`);
        evs.push(...pg.body.events.filter((e) => e.sequence <= target));
        cur = pg.body.nextCursor;
      }
      const elapsed = performance.now() - t0;
      if (i >= 20) samples.push(elapsed);
      // verification (outside the timed section): replay oracle to `target`, compare with snapshot + events
      const o = new OracleGame(practiceRules(8), seed);
      for (const d of oracle.moves.slice(0, target)) o.apply(d);
      if (snap) {
        const o2 = new OracleGame(practiceRules(8), seed);
        for (const d of oracle.moves.slice(0, snap.sequence)) o2.apply(d);
        if (canonicalOfServerState(snap.state) !== o2.canonical()) bad.push(`snapshot @${snap.sequence} differs from oracle`);
      }
      const o3 = new OracleGame(practiceRules(8), seed);
      if (snap) o3.state = snap.state;
      for (const e of evs) o3.apply(e.direction);
      if (o3.canonical() !== o.canonical()) bad.push(`seek ${target} differs from oracle`);
    }
    const s = summarize(samples);
    writeReport("ops05-replay-seek", { acceptedMoves: history, domainEvents: eventCount, snapshots: snaps.length, seeks: samples.length, ...s, target: "p95 seek < 250 ms using snapshots", bad });
    console.log(`OPS-05 moves=${history} p50=${s.p50Ms.toFixed(2)} p95=${s.p95Ms.toFixed(2)} p99=${s.p99Ms.toFixed(2)}`);
    expect(bad).toEqual([]);
    expect(s.p95Ms).toBeLessThan(250);
  }, 900_000);
});
