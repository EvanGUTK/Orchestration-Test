/**
 * OPS-03: 32 concurrent synthetic local games, 10,000 accepted commands, p95 < 100 ms authoritative response,
 * no loss / duplicates / deadlock. Private server + private temp DB (never the integration checkout's DB).
 * Every response is checked against the independent oracle, and every game is re-read at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, newCommandId } from "../acceptance/support/client.ts";
import { serverAvailable, startServer, type ServerHandle } from "../acceptance/support/server-process.ts";
import { OracleGame, canonicalOfServerState, practiceRules, unwrapGame } from "../integration/support/game-driver.ts";
import type { OState } from "../integration/oracle/game.ts";
import { summarize, writeReport } from "./support/stats.ts";

const GAMES = Number(process.env.OPS03_GAMES ?? 32);
const TOTAL = Number(process.env.OPS03_COMMANDS ?? 10_000);
const available = serverAvailable();
if (!available) console.warn("OPS-03 SKIPPED: apps/server/src/main.ts is not in this checkout (not a pass)");

type View = { id: string; state: OState };
type MoveRes = { game: View; changed: boolean };

describe.skipIf(!available)("OPS-03 32 concurrent games", () => {
  let server: ServerHandle;
  beforeAll(async () => {
    server = await startServer({ timeoutMs: 60_000 });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it(`${GAMES} games x ${Math.ceil(TOTAL / GAMES)} commands, p95 < 100 ms, oracle-exact`, async () => {
    const perGame = Math.ceil(TOTAL / GAMES);
    const latencies: number[] = [];
    const mismatches: string[] = [];
    let accepted = 0;
    const t0 = Date.now();

    const players = await Promise.all(
      Array.from({ length: GAMES }, async (_, i) => {
        const c = new ApiClient(server.baseUrl);
        const reg = await c.registerAndLogin(`ops3_${i}_${Date.now().toString(36)}`);
        expect(reg.status, reg.raw).toBeLessThan(300);
        const seed = `ops03-${i}`;
        const made = await c.post("/games", { mode: "practice", custom: { boardSize: 8, seed } });
        expect(made.status, made.raw).toBeLessThan(300);
        const g = unwrapGame<View>(made.body);
        return { c, g, seed, oracle: new OracleGame(practiceRules(8), seed) };
      }),
    );

    await Promise.all(
      players.map(async (p, idx) => {
        let rev = p.g.state.revision;
        for (let n = 0; n < perGame; n++) {
          const dir = p.oracle.nextDirection();
          if (!dir) break; // dead board: stop this game early; total is topped up below
          p.oracle.apply(dir);
          const r = await p.c.post<MoveRes>(`/games/${p.g.id}/moves`, { commandId: newCommandId(), expectedRevision: rev, direction: dir });
          latencies.push(r.ms);
          if (r.status !== 200 || !r.body.changed) {
            mismatches.push(`game ${idx} move ${n}: status ${r.status} ${r.raw.slice(0, 200)}`);
            return;
          }
          accepted++;
          rev = r.body.game.state.revision;
          if (canonicalOfServerState(r.body.game.state) !== p.oracle.canonical()) {
            mismatches.push(`game ${idx} move ${n}: state diverged from oracle`);
            return;
          }
        }
      }),
    );

    // final authoritative re-read: nothing lost, nothing duplicated
    for (const [idx, p] of players.entries()) {
      const now = unwrapGame<View>((await p.c.get(`/games/${p.g.id}`)).body);
      if (canonicalOfServerState(now.state) !== p.oracle.canonical()) mismatches.push(`game ${idx}: final state differs from oracle`);
    }
    const s = summarize(latencies);
    const file = writeReport("ops03-concurrent-games", {
      games: GAMES,
      acceptedCommands: accepted,
      wallMs: Date.now() - t0,
      concurrency: "one in-flight request per game, all games concurrent",
      ...s,
      target: "p95 < 100 ms; 10,000 accepted commands; no loss/duplicates/deadlock",
      mismatches,
    });
    console.log(`OPS-03 accepted=${accepted} p50=${s.p50Ms.toFixed(2)}ms p95=${s.p95Ms.toFixed(2)}ms p99=${s.p99Ms.toFixed(2)}ms report=${file}`);
    expect(mismatches).toEqual([]);
    expect(accepted).toBeGreaterThanOrEqual(TOTAL);
    expect(s.p95Ms).toBeLessThan(100);
  });
});
