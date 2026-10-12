/**
 * OPS-04 / DB-08: 100,000 leaderboard entries with high decimal scores; p95 of first/filter page < 200 ms;
 * exact, stable ordering; cursor pagination returns every entry exactly once.
 *
 * Seeding: a private temp database is migrated by the real server boot, the server is stopped, completed casual games
 * are bulk-inserted with node:sqlite (support/seed-leaderboard.ts), and the server is restarted on that file.
 * PERF_LEADERBOARD_SEEDER=<module exporting seed(dbPath, entries)> overrides the built-in seeder.
 * The dataset/ordering oracle self-checks always run; the live part needs GET /leaderboards (fails fast if missing).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbCli, withDb } from "../integration/support/db.ts";
import { ApiClient } from "../acceptance/support/client.ts";
import { serverAvailable, startServer, type ServerHandle } from "../acceptance/support/server-process.ts";
import { compareEntries, floatOrder, generateEntries, sortedEntries, type Entry } from "./support/leaderboard-oracle.ts";
import { seedCompletedGames } from "./support/seed-leaderboard.ts";
import { summarize, writeReport } from "./support/stats.ts";

const N = Number(process.env.OPS04_ENTRIES ?? 100_000);
const seederPath = process.env.PERF_LEADERBOARD_SEEDER;

describe("OPS-04 dataset oracle self-check", () => {
  it("is deterministic, has >2^53 scores and exact ties, and float sorting would be WRONG on it", () => {
    const a = generateEntries(5000);
    expect(generateEntries(5000)).toEqual(a);
    expect(a.some((e) => e.score.length > 20)).toBe(true);
    const exact = sortedEntries(a);
    for (let i = 1; i < exact.length; i++) expect(compareEntries(exact[i - 1]!, exact[i]!)).toBeLessThan(0);
    expect(floatOrder(a).map((e) => e.id)).not.toEqual(exact.map((e) => e.id));
  });
});

describe("OPS-04 seeder self-check (schema accepts the dataset; SQL ranking order == oracle)", () => {
  it("seeds 5000 entries into a migrated temp DB and the index order equals the oracle order", () => {
    const dir = mkdtempSync(join(tmpdir(), "q2048-seed-"));
    try {
      const path = join(dir, "game.sqlite3");
      expect(runDbCli(path, ["migrate"]).code).toBe(0);
      const entries = generateEntries(5000, "seedcheck");
      seedCompletedGames(path, entries);
      const got = withDb(path, (db) =>
        (db.prepare("SELECT id FROM games ORDER BY length(score) DESC, score DESC, length(max_exponent) DESC, max_exponent DESC, created_at, id").all() as { id: string }[]).map((r) => r.id),
      );
      expect(got).toEqual(sortedEntries(entries).map((e) => e.id));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const live = serverAvailable();
if (!live) console.warn("OPS-04 live part SKIPPED: apps/server missing (not a pass)");

describe.skipIf(!live)("OPS-04 100k leaderboard", () => {
  let server: ServerHandle;
  let entries: Entry[];
  beforeAll(async () => {
    entries = generateEntries(N);
    // start once to migrate, stop, seed the DB directly, start again
    server = await startServer({ timeoutMs: 60_000 });
    const probe = await new ApiClient(server.baseUrl).get("/leaderboards?kind=casual&limit=1");
    expect(probe.status, `GET /leaderboards must exist before seeding 100k rows: ${probe.raw}`).toBe(200);
    await server.kill("SIGTERM");
    if (seederPath) {
      const mod = (await import(pathToFileURL(seederPath).href)) as { seed: (db: string, e: Entry[]) => Promise<void> | void };
      await mod.seed(server.dbPath, entries);
    } else seedCompletedGames(server.dbPath, entries);
    await server.restart();
  }, 600_000);
  afterAll(async () => {
    await server?.stop();
  });

  it("first/filter pages p95 < 200 ms; full cursor walk equals the exact oracle order", async () => {
    const c = new ApiClient(server.baseUrl);
    const first: number[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await c.get(`/leaderboards?kind=casual&limit=${i % 2 ? 25 : 100}`);
      expect(r.status, r.raw).toBe(200);
      if (i >= 10) first.push(r.ms); // 10 warmup requests
    }
    const s = summarize(first);
    const expected = sortedEntries(entries).map((e) => e.id);
    const got: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Awaited<ReturnType<typeof c.get<{ items: { gameId?: string; score?: string }[]; nextCursor: string | null }>>> = await c.get(
        `/leaderboards?kind=casual&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(r.status, r.raw).toBe(200);
      got.push(...r.body.items.map((i) => i.gameId ?? ""));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < N);
    const rss = process.memoryUsage().rss;
    writeReport("ops04-leaderboard", { entries: N, pagesWalked: pages, ...s, clientRssBytes: rss, target: "p95 first/filter page < 200 ms" });
    console.log(`OPS-04 p50=${s.p50Ms.toFixed(2)} p95=${s.p95Ms.toFixed(2)} p99=${s.p99Ms.toFixed(2)} pages=${pages}`);
    expect(got.length).toBe(expected.length);
    expect(got).toEqual(expected);
    expect(s.p95Ms).toBeLessThan(200);
  }, 600_000);
});
