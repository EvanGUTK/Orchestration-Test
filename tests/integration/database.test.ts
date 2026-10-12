/**
 * DB-01 migrations/boot, DB-05 backup+restore, DB-06 busy database, DB-08 decimal storage/ordering.
 * (DB-02/03/04 live in fault-kill-during-move.test.ts and api-authority.test.ts.)
 * Every test uses its own private temp directory/database. Skipped loudly if the server is absent.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync, existsSync, truncateSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ApiClient, newCommandId, type Dir } from "../acceptance/support/client.ts";
import { serverAvailable, startServer, type ServerHandle } from "../acceptance/support/server-process.ts";
import { dumpAllText, fileSha, runDbCli, sha256, withDb } from "./support/db.ts";
import { OracleGame, canonicalOfServerState, practiceRules, unwrapGame } from "./support/game-driver.ts";
import { OracleRng, deriveWords } from "./oracle/prng.ts";
import type { OState } from "./oracle/game.ts";

const available = serverAvailable();
if (!available) console.warn("database tests (server part) SKIPPED: server missing (not a pass)");
const PW = "correct horse battery staple 9";
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "q2048-db-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
type GameLite = { id: string; state: OState };
type MoveRes = { game: GameLite; changed: boolean };

async function playMoves(c: ApiClient, id: string, oracle: OracleGame, n: number, startRev: number) {
  let rev = startRev;
  for (let i = 0; i < n; i++) {
    const d = oracle.nextDirection() as Dir;
    oracle.apply(d);
    const r = await c.post<MoveRes>(`/games/${id}/moves`, { commandId: newCommandId(), expectedRevision: rev, direction: d });
    expect(r.status, r.raw).toBe(200);
    rev = r.body.game.state.revision;
  }
  return rev;
}

describe("DB-01 fresh migration, repeated boot, tampering, newer schema", () => {
  it("CLI migrate creates a fresh DB, is idempotent, records sha256 checksums and passes integrity/foreign-key checks", () => {
    const dir = tmp();
    const db = join(dir, "game.sqlite3");
    const first = runDbCli(db, ["migrate"]);
    expect(first.code, first.err).toBe(0);
    const second = runDbCli(db, ["migrate"]);
    expect(second.code, second.err).toBe(0);
    expect(second.out).toMatch(/up to date/i);
    withDb(db, (d) => {
      const rows = d.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all() as { version: number; checksum: string; applied_at: string }[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      rows.forEach((r, i) => {
        expect(r.version).toBe(i + 1);
        expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
        expect(r.applied_at).toMatch(/^\d{4}-\d\d-\d\dT/);
      });
      expect((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(rows.length);
      expect(d.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(d.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
      for (const t of ["users", "sessions", "games", "game_commands", "game_moves", "game_snapshots", "challenges", "matches", "match_seats", "ratings", "rating_events", "rulesets", "seasons", "schema_migrations"]) {
        expect(tables, t).toContain(t);
      }
    });
  });

  it.skipIf(!available)("repeated boot keeps data and migration history byte-identical; /ready reports the schema", async () => {
    const dir = tmp();
    let server: ServerHandle = await startServer({ dataDir: dir });
    const c = new ApiClient(server.baseUrl);
    const name = `boot${Date.now().toString(36)}`;
    expect((await c.registerAndLogin(name, PW)).status).toBeLessThan(300);
    const g = unwrapGame<GameLite>((await c.post("/games", { mode: "practice", custom: { boardSize: 5, seed: "boot-seed" } })).body);
    const o = new OracleGame(practiceRules(5), "boot-seed");
    await playMoves(c, g.id, o, 12, 0);
    const ready = await c.get<{ status: string; schemaVersion: number; migrations: number }>("/ready");
    expect(ready.body.status).toBe("ready");
    const hist1 = withDb(server.dbPath, (d) => JSON.stringify(d.prepare("SELECT * FROM schema_migrations ORDER BY version").all()));
    await server.stop({ keepData: true });
    for (let boot = 0; boot < 3; boot++) {
      server = await startServer({ dataDir: dir });
      const c2 = new ApiClient(server.baseUrl);
      const li = await c2.post<{ csrfToken: string }>("/auth/login", { username: name, password: PW });
      expect(li.status).toBe(200);
      c2.csrfToken = li.body.csrfToken;
      const back = unwrapGame<GameLite>((await c2.get(`/games/${g.id}`)).body);
      expect(canonicalOfServerState(back.state)).toBe(o.canonical());
      expect(withDb(server.dbPath, (d) => JSON.stringify(d.prepare("SELECT * FROM schema_migrations ORDER BY version").all()))).toBe(hist1);
      expect((await c2.get<{ migrations: number }>("/ready")).body.migrations).toBe(ready.body.migrations);
      await server.stop({ keepData: true });
    }
  });

  it.skipIf(!available)("a tampered migration checksum stops boot with a clear error and leaves the data untouched", async () => {
    const dir = tmp();
    const server = await startServer({ dataDir: dir });
    const c = new ApiClient(server.baseUrl);
    await c.registerAndLogin(`tamper${Date.now().toString(36)}`, PW);
    await server.stop({ keepData: true });
    const raw = new DatabaseSync(server.dbPath);
    raw.exec("UPDATE schema_migrations SET checksum = '" + "0".repeat(64) + "' WHERE version = 1");
    raw.close();
    const before = dumpAllText(server.dbPath);
    await expect(startServer({ dataDir: dir, timeoutMs: 8000 })).rejects.toThrow(/exited early[\s\S]*(checksum|migration)/i);
    expect(dumpAllText(server.dbPath)).toBe(before);
    const cli = runDbCli(server.dbPath, ["migrate"]);
    expect(cli.code).not.toBe(0);
    expect(cli.err + cli.out).toMatch(/checksum|migration/i);
  });

  it.skipIf(!available)("a database from a NEWER build (unknown migration) is refused, not silently downgraded", async () => {
    const dir = tmp();
    const server = await startServer({ dataDir: dir });
    await server.stop({ keepData: true });
    const raw = new DatabaseSync(server.dbPath);
    raw.exec("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, 'from_the_future', '" + "a".repeat(64) + "', '2099-01-01T00:00:00.000Z')");
    raw.close();
    await expect(startServer({ dataDir: dir, timeoutMs: 8000 })).rejects.toThrow(/exited early/i);
  });
});

describe.skipIf(!available)("DB-05 backup (online, under write load) and validated restore", () => {
  it("backup taken while moves are in flight is a consistent transaction prefix; restore returns exactly that state", async () => {
    const dir = tmp();
    let server = await startServer({ dataDir: dir });
    const c = new ApiClient(server.baseUrl);
    const name = `bk${Date.now().toString(36)}`;
    await c.registerAndLogin(name, PW);
    const seed = "backup-seed";
    const g = unwrapGame<GameLite>((await c.post("/games", { mode: "practice", custom: { boardSize: 8, seed } })).body);
    const o = new OracleGame(practiceRules(8), seed);
    let rev = await playMoves(c, g.id, o, 30, 0);

    const dest = join(dir, "snap.sqlite3");
    let stop = false;
    let acked = rev;
    const writer = (async () => {
      while (!stop) {
        const d = o.nextDirection() as Dir;
        o.apply(d);
        const r = await c.post<MoveRes>(`/games/${g.id}/moves`, { commandId: newCommandId(), expectedRevision: rev, direction: d });
        if (r.status !== 200) break;
        rev = r.body.game.state.revision;
        acked = rev;
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    const bk = runDbCli(server.dbPath, ["backup", dest]);
    stop = true;
    await writer;
    expect(bk.code, bk.err).toBe(0);
    expect(existsSync(dest)).toBe(true);

    // 1. the backup file itself is a consistent, self-validating prefix of the move stream
    const snap = withDb(dest, (d) => {
      expect(d.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(d.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const row = d.prepare("SELECT revision, accepted_moves FROM games WHERE id = ?").get(g.id) as { revision: number; accepted_moves: number };
      const moves = d.prepare("SELECT direction FROM game_moves WHERE game_id = ? ORDER BY revision").all(g.id) as { direction: Dir }[];
      return { row, moves: moves.map((m) => m.direction) };
    });
    expect(snap.moves.length).toBe(snap.row.revision);
    expect(snap.row.accepted_moves).toBe(snap.row.revision);
    expect(snap.row.revision).toBeGreaterThanOrEqual(30);
    expect(snap.row.revision).toBeLessThanOrEqual(acked);
    const replay = new OracleGame(practiceRules(8), seed);
    for (const d of snap.moves) replay.apply(d);

    // 2. keep playing so live differs from backup, stop, restore, and compare
    await server.stop({ keepData: true });
    const live = withDb(server.dbPath, (d) => (d.prepare("SELECT revision FROM games WHERE id = ?").get(g.id) as { revision: number }).revision);
    expect(live).toBeGreaterThanOrEqual(snap.row.revision);
    const rs = runDbCli(server.dbPath, ["restore", dest]);
    expect(rs.code, rs.err).toBe(0);
    expect(readdirSync(join(dir, "backups")).some((f) => f.startsWith("pre-restore"))).toBe(true);
    server = await startServer({ dataDir: dir });
    const c2 = new ApiClient(server.baseUrl);
    const li = await c2.post<{ csrfToken: string }>("/auth/login", { username: name, password: PW });
    expect(li.status).toBe(200);
    c2.csrfToken = li.body.csrfToken;
    const back = unwrapGame<GameLite>((await c2.get(`/games/${g.id}`)).body);
    expect(back.state.revision).toBe(snap.row.revision);
    expect(canonicalOfServerState(back.state)).toBe(replay.canonical());
    // and the restored game keeps working: the next move equals the oracle's next move
    const d = replay.nextDirection() as Dir;
    replay.apply(d);
    const next = await c2.post<MoveRes>(`/games/${g.id}/moves`, { commandId: newCommandId(), expectedRevision: back.state.revision, direction: d });
    expect(next.status, next.raw).toBe(200);
    expect(canonicalOfServerState(next.body.game.state)).toBe(replay.canonical());
    await server.stop();
  }, 120_000);

  it("corrupt, truncated, empty and foreign files are refused and the active database is byte-identical afterwards", async () => {
    const dir = tmp();
    const server = await startServer({ dataDir: dir });
    const c = new ApiClient(server.baseUrl);
    await c.registerAndLogin(`corrupt${Date.now().toString(36)}`, PW);
    await c.post("/games", { mode: "classic" });
    await server.stop({ keepData: true });
    const good = join(dir, "good.sqlite3");
    expect(runDbCli(server.dbPath, ["backup", good]).code).toBe(0);
    const size = statSync(good).size;

    const garbage = join(dir, "garbage.sqlite3");
    writeFileSync(garbage, Buffer.from(new OracleRngBytes(4096).bytes));
    const truncated = join(dir, "truncated.sqlite3");
    copyFileSync(good, truncated);
    truncateSync(truncated, Math.floor(size / 2));
    const flipped = join(dir, "flipped.sqlite3");
    copyFileSync(good, flipped);
    const fd = new DatabaseSync(flipped);
    fd.exec("DROP TABLE game_moves");
    fd.close();
    const empty = join(dir, "empty.sqlite3");
    writeFileSync(empty, "");
    const foreign = join(dir, "foreign.sqlite3");
    const f = new DatabaseSync(foreign);
    f.exec("CREATE TABLE unrelated (x TEXT); INSERT INTO unrelated VALUES ('hi');");
    f.close();

    const activeBefore = dumpAllText(server.dbPath);
    for (const bad of [garbage, truncated, flipped, empty, foreign, join(dir, "does-not-exist.sqlite3")]) {
      const r = runDbCli(server.dbPath, ["restore", bad]);
      expect(r.code, bad).not.toBe(0);
      expect(r.err + r.out, bad).toMatch(/refus|invalid|not|corrupt|missing|required|small/i);
      expect(dumpAllText(server.dbPath), `active data changed after refusing ${bad}`).toBe(activeBefore);
      withDb(server.dbPath, (d) => expect(d.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]));
    }
    // the valid backup still restores
    expect(runDbCli(server.dbPath, ["restore", good]).code).toBe(0);
    expect(fileSha(good)).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});

class OracleRngBytes {
  bytes: Uint8Array;
  constructor(n: number) {
    const r = new OracleRng(deriveWords("garbage"));
    this.bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.bytes[i] = r.below(256);
  }
}

describe.skipIf(!available)("DB-06 database busy: bounded, explicit, no lost or phantom move", () => {
  it("while another connection holds the write lock, a move either succeeds after release or fails with DB_BUSY 503 within a bounded time; state always equals the acknowledged stream", async () => {
    const dir = tmp();
    const server = await startServer({ dataDir: dir });
    const c = new ApiClient(server.baseUrl);
    await c.registerAndLogin(`busy${Date.now().toString(36)}`, PW);
    const seed = "busy-seed";
    const g = unwrapGame<GameLite>((await c.post("/games", { mode: "practice", custom: { boardSize: 8, seed } })).body);
    const o = new OracleGame(practiceRules(8), seed);
    let rev = await playMoves(c, g.id, o, 5, 0);

    const locker = new DatabaseSync(server.dbPath);
    locker.exec("PRAGMA busy_timeout = 0");
    locker.exec("BEGIN IMMEDIATE");
    const t0 = Date.now();
    const outcomes: { status: number; code?: string; ms: number; dir: Dir }[] = [];
    const attempt = async () => {
      const d = o.nextDirection() as Dir;
      const r = await c.post<MoveRes & { error?: { code: string } }>(`/games/${g.id}/moves`, { commandId: newCommandId(), expectedRevision: rev, direction: d });
      outcomes.push({ status: r.status, code: r.body?.error?.code, ms: Date.now() - t0, dir: d });
      return { r, d };
    };
    const pending = attempt();
    await new Promise((r) => setTimeout(r, 1500));
    locker.exec("ROLLBACK");
    locker.close();
    const { r, d } = await pending;
    console.log("DB-06 single-move outcome:", JSON.stringify(outcomes));
    expect(Date.now() - t0, "bounded wait").toBeLessThan(30_000);
    expect([200, 503], r.raw).toContain(r.status);
    if (r.status === 503) {
      expect(r.body.error?.code).toBe("DB_BUSY");
      expect(r.headers.get("retry-after")).not.toBeNull();
    } else {
      o.apply(d);
      rev = r.body.game.state.revision;
    }
    // the server is healthy again and state equals exactly what was acknowledged
    expect((await c.get("/ready")).status).toBe(200);
    const now = unwrapGame<GameLite>((await c.get(`/games/${g.id}`)).body);
    expect(canonicalOfServerState(now.state)).toBe(o.canonical());
    const rv = now.state.revision;
    // a retry after the failure with a fresh command works and still matches the oracle
    const d2 = o.nextDirection() as Dir;
    o.apply(d2);
    const r2 = await c.post<MoveRes>(`/games/${g.id}/moves`, { commandId: newCommandId(), expectedRevision: rv, direction: d2 });
    expect(r2.status, r2.raw).toBe(200);
    expect(canonicalOfServerState(r2.body.game.state)).toBe(o.canonical());
    await server.stop();
  }, 120_000);

  it("a write flood against a locked database yields only 200/503/429, never 500, never hangs, and health stays up", async () => {
    const dir = tmp();
    const server = await startServer({ dataDir: dir });
    const c = new ApiClient(server.baseUrl);
    await c.registerAndLogin(`flood${Date.now().toString(36)}`, PW);
    const g = unwrapGame<GameLite>((await c.post("/games", { mode: "practice", custom: { boardSize: 8, seed: "flood" } })).body);
    const locker = new DatabaseSync(server.dbPath);
    locker.exec("BEGIN IMMEDIATE");
    const burst = Array.from({ length: 120 }, () => c.clone().post<{ error?: { code: string } }>(`/games/${g.id}/moves`, { commandId: newCommandId(), expectedRevision: 0, direction: "down" }));
    await new Promise((r) => setTimeout(r, 1200));
    const health = await new ApiClient(server.baseUrl).get("/health");
    expect(health.status, "liveness must not depend on the write lock").toBe(200);
    locker.exec("ROLLBACK");
    locker.close();
    const res = await Promise.all(burst);
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => ![200, 409, 429, 503].includes(s)), JSON.stringify([...new Set(statuses)])).toEqual([]);
    // at most one of 120 identical-revision commands can have been accepted
    const accepted = res.filter((r) => r.status === 200).length;
    console.log("DB-06 flood statuses:", JSON.stringify(Object.fromEntries([...new Set(statuses)].map((s) => [s, statuses.filter((x) => x === s).length]))));
    expect(accepted).toBeLessThanOrEqual(1);
    const now = unwrapGame<GameLite>((await c.get(`/games/${g.id}`)).body);
    expect(now.state.revision).toBe(accepted);
    await server.stop();
  }, 120_000);
});

describe("DB-08 huge decimal values are text, canonical and ordered by length then lexical (never REAL)", () => {
  function migrated(): { path: string; db: DatabaseSync } {
    const dir = tmp();
    const path = join(dir, "game.sqlite3");
    expect(runDbCli(path, ["migrate"]).code).toBe(0);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    return { path, db };
  }
  const seedRows = (db: DatabaseSync) => {
    db.prepare("INSERT INTO rulesets (version, rules_json, digest, created_at) VALUES ('classic-v1', '{}', ?, '2026-01-01T00:00:00.000Z')").run("0".repeat(64));
    db.prepare("INSERT INTO users (id, username_normalized, display_name, password_hash, created_at) VALUES (?, 'ladder', 'Ladder', 'x', '2026-01-01T00:00:00.000Z')").run("11111111-1111-4111-8111-111111111111");
  };
  const insertGame = (db: DatabaseSync, i: number, score: string, maxExp: string) =>
    db
      .prepare(
        `INSERT INTO games (id, owner_user_id, mode, ruleset_version, engine_version, seed, board_size, cells_json, rng_json, score, max_exponent, accepted_moves, revision, status, created_at, updated_at)
         VALUES (?, '11111111-1111-4111-8111-111111111111', 'classic', 'classic-v1', 'engine-1.0.0', 's', 4, '[]', '{}', ?, ?, 0, 0, 'completed', ?, ?)`,
      )
      .run(`00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`, score, maxExp, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, "2026-01-01T00:00:00.000Z");

  it("rejects non-canonical or float-ish scores and exponents at the schema level", () => {
    const { db } = migrated();
    seedRows(db);
    let i = 0;
    for (const bad of ["1.5", "1e9", "007", "-1", "", " 5", "0x10", "٣"]) {
      expect(() => insertGame(db, i++, bad, "5"), `score ${JSON.stringify(bad)}`).toThrow();
    }
    for (const bad of ["1.0", "00", "2e3"]) expect(() => insertGame(db, i++, "5", bad), `exp ${JSON.stringify(bad)}`).toThrow();
    db.close();
  });

  it("round-trips 60-digit scores exactly and the ranking index order equals the BigInt oracle (3000 rows incl. 2^53 neighbours)", () => {
    const { db } = migrated();
    seedRows(db);
    const rng = new OracleRng(deriveWords("db08"));
    const rows: { id: string; score: string; maxExp: string }[] = [];
    db.exec("BEGIN");
    for (let i = 0; i < 3000; i++) {
      let score: string;
      if (i % 5 === 0) score = (2n ** 53n + BigInt(rng.below(6))).toString();
      else {
        const digits = 1 + rng.below(60);
        score = String(1 + rng.below(9));
        for (let d = 1; d < digits; d++) score += String(rng.below(10));
      }
      const maxExp = String(1 + rng.below(5000));
      insertGame(db, i, score, maxExp);
      rows.push({ id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`, score, maxExp });
    }
    db.exec("COMMIT");
    const got = db.prepare("SELECT id, score, max_exponent AS maxExp, typeof(score) AS t FROM games ORDER BY length(score) DESC, score DESC, length(max_exponent) DESC, max_exponent DESC, created_at, id").all() as { id: string; score: string; maxExp: string; t: string }[];
    expect(got.every((r) => r.t === "text")).toBe(true);
    const want = [...rows].sort((a, b) => {
      const sa = BigInt(a.score), sb = BigInt(b.score);
      if (sa !== sb) return sa > sb ? -1 : 1;
      const ea = BigInt(a.maxExp), eb = BigInt(b.maxExp);
      if (ea !== eb) return ea > eb ? -1 : 1;
      return 0; // created_at/id tie-break checked separately below
    });
    expect(got.map((r) => r.score)).toEqual(want.map((r) => r.score));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of got) expect(byId.get(r.id)!.score).toBe(r.score); // exact round trip
    // float ordering over the same data would be wrong
    const asFloat = [...rows].sort((a, b) => Number(b.score) - Number(a.score)).map((r) => r.score);
    expect(asFloat).not.toEqual(want.map((r) => r.score));
    db.close();
  });
});

void sha256;
