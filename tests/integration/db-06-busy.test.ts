// DB-06 | Database busy / disk full — bounded queue/error, no corrupt state or hidden lost move.
// Busy: a second connection holds BEGIN EXCLUSIVE while the app writes.
// Disk full: SQLITE_FULL simulated with PRAGMA max_page_count on the app's own connection (a real
// full volume needs an admin-created size-limited disk on Windows; documented in the QA report).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Direction, GameState } from "@g2048/contracts";
import { legalMoves } from "@g2048/engine";
import { createTestApp } from "./helpers/app.js";
import type { TestApp } from "./helpers/app.js";
import { cmd, createGame, getGame, move, moveRows } from "./helpers/games.js";
import { Client, expectErrorEnvelope } from "./helpers/http.js";
import type { Res } from "./helpers/http.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const integrity = (db: DatabaseSync) =>
  (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;

describe("DB-06 database busy and disk full", () => {
  it(
    "a write blocked by another connection fails as 503 DB_BUSY in bounded time, is not applied, and can be retried",
    {
      timeout: 60_000,
    },
    async () => {
      t = await createTestApp();
      const c = new Client(t.app);
      const g = await createGame(c, { mode: "classic", seed: "db06-busy" });
      const d = legalMoves(g.state.board)[0] as Direction;
      const id = cmd("busy");

      const lock = new DatabaseSync(t.dbPath);
      lock.exec("PRAGMA busy_timeout = 0");
      lock.exec("BEGIN EXCLUSIVE");
      const t0 = Date.now();
      let res: Res;
      try {
        res = await move(c, g.game.id, d, 0, id);
      } finally {
        lock.exec("ROLLBACK");
        lock.close();
      }
      expect(Date.now() - t0, "bounded wait").toBeLessThan(15_000);
      expect(res.status, res.text).toBe(503);
      expectErrorEnvelope(res, "DB_BUSY");
      expect((await getGame(c, g.game.id)).state.revision, "no hidden move").toBe(0);
      expect(moveRows(t.db, g.game.id)).toHaveLength(0);

      const retry = await move(c, g.game.id, d, 0, id);
      expect(retry.status, "same command id succeeds once the database is free").toBe(200);
      expect(retry.json.state.revision).toBe(1);
      expect(integrity(t.db)).toBe("ok");
    },
  );

  it(
    "a burst against a tiny writer queue while locked: every response is 200 or 503, and responses match the database",
    {
      timeout: 120_000,
    },
    async () => {
      t = await createTestApp({ writerQueueMax: 1 });
      const c = new Client(t.app);
      const games: { id: string; state: GameState }[] = [];
      for (let i = 0; i < 6; i++) {
        const g = await createGame(c, { mode: "classic", seed: `db06-q-${i}` });
        games.push({ id: g.game.id, state: g.state });
      }
      await c.refreshCsrf();
      const lock = new DatabaseSync(t.dbPath);
      lock.exec("PRAGMA busy_timeout = 0");
      lock.exec("BEGIN EXCLUSIVE");
      let results: Res[];
      try {
        results = await Promise.all(
          games.map((g) => move(c, g.id, legalMoves(g.state.board)[0] as Direction, 0)),
        );
      } finally {
        lock.exec("ROLLBACK");
        lock.close();
      }
      for (const [i, r] of results.entries()) {
        expect([200, 503], r.text).toContain(r.status);
        if (r.status === 503) expectErrorEnvelope(r, "DB_BUSY");
        const now = await getGame(c, games[i]!.id);
        expect(now.state.revision, `game ${i}: response ${r.status} must match stored state`).toBe(
          r.status === 200 ? 1 : 0,
        );
      }
      expect(
        results.some((r) => r.status === 503),
        "the locked database must surface DB_BUSY",
      ).toBe(true);
      expect(integrity(t.db)).toBe("ok");
    },
  );

  it(
    "SQLITE_FULL (simulated disk full) surfaces a typed error, loses nothing silently, and recovers",
    {
      timeout: 120_000,
    },
    async () => {
      t = await createTestApp();
      const c = new Client(t.app);
      const g = await createGame(c, {
        mode: "practice",
        practice: { size: 8, seed: "db06-full", undo: false },
      });
      const pages = (t.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
      t.db.exec(`PRAGMA max_page_count = ${pages}`);
      let acknowledged = g.state;
      let failure: { res: Res; direction: Direction; id: string } | null = null;
      try {
        for (let i = 0; i < 600 && acknowledged.status === "active"; i++) {
          const legal = legalMoves(acknowledged.board);
          const d = legal[i % legal.length] as Direction;
          const id = cmd("full");
          const r = await move(c, g.game.id, d, acknowledged.revision, id);
          if (r.status !== 200) {
            failure = { res: r, direction: d, id };
            break;
          }
          acknowledged = r.json.state;
        }
      } finally {
        t.db.exec("PRAGMA max_page_count = 1073741823");
      }
      expect(failure, "the size cap must eventually make a write fail").not.toBeNull();
      const f = failure!;
      expect([500, 503], f.res.text).toContain(f.res.status);
      expectErrorEnvelope(f.res);
      const stored = (await getGame(c, g.game.id)).state;
      expect(stored, "state is the last acknowledged one").toEqual(acknowledged);
      expect(moveRows(t.db, g.game.id)).toHaveLength(acknowledged.revision);
      expect(integrity(t.db)).toBe("ok");
      const retry = await move(c, g.game.id, f.direction, acknowledged.revision, f.id);
      expect(retry.status, retry.text).toBe(200);
      expect(retry.json.state.revision).toBe(acknowledged.revision + 1);
    },
  );
});
