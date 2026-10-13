import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULESETS } from "@g2048/contracts";
import {
  acquireDatabaseLock,
  backupDatabase,
  canonicalRulesetJson,
  compareCanonicalDecimal,
  DatabaseWriter,
  DbBusyError,
  decimalOrderBy,
  lockPathFor,
  migrate,
  migrationChecksum,
  MIGRATIONS,
  MigrationError,
  openDatabase,
  prepareDatabase,
  restoreDatabase,
  RestoreError,
  sha256Hex,
  type Migration,
} from "./index.js";
import { insertTestGame, insertTestUser, makeTempDir, TEST_NOW } from "./test-helpers.js";

const ALL_VERSIONS = MIGRATIONS.map((m) => m.version);
const LATEST = MIGRATIONS.length;
const NEXT = LATEST + 1;

const EXPECTED_TABLES = [
  "challenge_attempts",
  "challenges",
  "bot_runs",
  "game_commands",
  "game_moves",
  "game_snapshots",
  "games",
  "guests",
  "match_events",
  "match_seats",
  "matches",
  "profiles",
  "rating_events",
  "ratings",
  "replay_exports",
  "replay_imports",
  "rulesets",
  "schema_migrations",
  "seasons",
  "sessions",
  "users",
].sort();

let temp: ReturnType<typeof makeTempDir>;
let dbPath: string;
const open: DatabaseSync[] = [];

function track(db: DatabaseSync): DatabaseSync {
  open.push(db);
  return db;
}

beforeEach(() => {
  temp = makeTempDir();
  dbPath = join(temp.dir, "game.sqlite3");
});

afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  temp.cleanup();
});

function fileSha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("DB-01 migrations", () => {
  it("fresh migrate creates every table, records checksum, seeds rulesets, enables WAL + FKs", async () => {
    const { db, applied, preflightBackup } = await prepareDatabase(dbPath);
    track(db);
    expect(applied).toEqual(ALL_VERSIONS);
    expect(preflightBackup).toBeNull();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(EXPECTED_TABLES);
    const strict = db
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table'")
      .all() as {
      name: string;
      strict: number;
    }[];
    for (const row of strict.filter((r) => !r.name.startsWith("sqlite_")))
      expect(row, row.name).toMatchObject({ strict: 1 });
    // No REAL columns anywhere.
    for (const table of EXPECTED_TABLES) {
      const cols = db.prepare(`SELECT type FROM pragma_table_info('${table}')`).all() as { type: string }[];
      for (const col of cols) expect(col.type.toUpperCase()).not.toBe("REAL");
    }
    const migration = db.prepare("SELECT version, checksum FROM schema_migrations").all();
    expect(migration).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version, checksum: migrationChecksum(m) })),
    );
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);

    const rulesets = db
      .prepare("SELECT version, rules_json, digest FROM rulesets ORDER BY version")
      .all() as {
      version: string;
      rules_json: string;
      digest: string;
    }[];
    expect(rulesets.map((r) => r.version)).toEqual([
      "bot-v1",
      "classic-v1",
      "duel-v1",
      "practice-v1",
      "ranked-v1",
    ]);
    for (const row of rulesets) {
      expect(row.digest).toBe(sha256Hex(row.rules_json));
      const builtin = (RULESETS as Record<string, (typeof RULESETS)[keyof typeof RULESETS]>)[row.version];
      if (builtin) expect(row.rules_json).toBe(canonicalRulesetJson(builtin));
    }
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const name of [
      "games_owner_user_saves",
      "games_casual_standings",
      "challenge_attempts_standings",
      "matches_status",
      "ratings_standings",
    ]) {
      expect(indexes).toContain(name);
    }
  });

  it("repeated boot is idempotent and keeps data", async () => {
    const first = await prepareDatabase(dbPath);
    insertTestUser(first.db, "alice");
    first.db.close();
    const second = await prepareDatabase(dbPath);
    track(second.db);
    expect(second.applied).toEqual([]);
    expect(second.preflightBackup).toBeNull();
    expect(second.db.prepare("SELECT username_normalized FROM users").all()).toEqual([
      { username_normalized: "alice" },
    ]);
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM rulesets").get()).toEqual({ n: 5 });
  });

  it("detects a tampered migration checksum and refuses to boot", async () => {
    const { db } = await prepareDatabase(dbPath);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("f".repeat(64));
    db.close();
    await expect(prepareDatabase(dbPath)).rejects.toThrow(/checksum mismatch/);
  });

  it("refuses a database from a newer build (unknown migration version)", async () => {
    const { db } = await prepareDatabase(dbPath);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', ?, ?)",
    ).run("a".repeat(64), TEST_NOW);
    db.close();
    await expect(prepareDatabase(dbPath)).rejects.toThrow(/unknown to this build/);
  });

  it("rulesets are immutable and a tampered ruleset fails boot", async () => {
    const { db } = await prepareDatabase(dbPath);
    expect(() =>
      db.prepare("UPDATE rulesets SET rules_json = rules_json WHERE version = 'ranked-v1'").run(),
    ).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM rulesets").run()).toThrow(/immutable/);
    db.exec("DROP TRIGGER rulesets_immutable_update");
    db.prepare(
      `UPDATE rulesets SET rules_json = json_set(rules_json, '$.moveCap', 5000) WHERE version = 'ranked-v1'`,
    ).run();
    db.close();
    await expect(prepareDatabase(dbPath)).rejects.toThrow(/digest mismatch/);
  });

  it("a failing upgrade rolls back, keeps prior data, and leaves a preflight backup", async () => {
    const { db } = await prepareDatabase(dbPath);
    insertTestUser(db, "keepme");
    db.close();
    const bad: Migration = {
      version: NEXT,
      name: "broken",
      sql: "CREATE TABLE half_done (x INTEGER) STRICT; ALTER TABLE users ADD COLUMN bogus TEXT; INSERT INTO no_such_table VALUES (1);",
    };
    await expect(prepareDatabase(dbPath, { migrations: [...MIGRATIONS, bad] })).rejects.toBeInstanceOf(
      MigrationError,
    );
    const backups = readdirSync(temp.dir).filter((f) => f.includes(`.pre-migrate-v${LATEST}-to-v${NEXT}-`));
    expect(backups).toHaveLength(1);

    const after = track(openDatabase(dbPath));
    expect(after.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      ALL_VERSIONS.map((version) => ({ version })),
    );
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
    const cols = (
      after.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("bogus");
    expect(after.prepare("SELECT username_normalized FROM users").all()).toEqual([
      { username_normalized: "keepme" },
    ]);
    after.close();

    const good: Migration = {
      version: NEXT,
      name: "add-table",
      sql: "CREATE TABLE extra (x INTEGER) STRICT;",
    };
    const upgraded = await prepareDatabase(dbPath, { migrations: [...MIGRATIONS, good] });
    track(upgraded.db);
    expect(upgraded.applied).toEqual([NEXT]);
    expect(upgraded.preflightBackup).not.toBeNull();
    expect(existsSync(upgraded.preflightBackup as string)).toBe(true);
  });
});

describe("schema constraints", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = track(openDatabase(dbPath));
    migrate(db);
  });

  it("scores must be canonical decimal TEXT (no REAL, sign, leading zero, or garbage)", () => {
    for (const bad of ["012", "1.5", "-1", "", "1e9", " 1", "abc", 1.5, 42]) {
      expect(() => insertTestGame(db, { score: bad }), String(bad)).toThrow();
    }
    const huge = "9".repeat(400);
    insertTestGame(db, { score: huge });
    insertTestGame(db, { score: "0" });
    expect(db.prepare("SELECT typeof(score) AS t FROM games WHERE score = ?").get(huge)).toEqual({
      t: "text",
    });
  });

  it("rejects negative revisions, unknown states and guest-owned ranked games", () => {
    expect(() => insertTestGame(db, { revision: -1 })).toThrow();
    expect(() => insertTestGame(db, { status: "won" })).toThrow();
    expect(() => insertTestGame(db, { mode: "ranked", ruleset: "ranked-v1" })).toThrow(); // no human owner
    expect(() => insertTestGame(db, { mode: "practice", ruleset: "classic-v1" })).toThrow(); // mode/ruleset mismatch
    const guest = randomUUID();
    db.prepare("INSERT INTO guests (id, created_at, last_seen_at) VALUES (?, ?, ?)").run(
      guest,
      TEST_NOW,
      TEST_NOW,
    );
    const user = insertTestUser(db, "ranked_player");
    expect(() =>
      db
        .prepare("UPDATE games SET owner_guest_id = ? WHERE id = ?")
        .run(guest, insertTestGame(db, { mode: "ranked", ruleset: "ranked-v1", ownerUserId: user })),
    ).toThrow();
    expect(() =>
      insertTestGame(db, { mode: "duel-human", ruleset: "duel-v1", ownerGuestId: guest }),
    ).toThrow();
  });

  it("usernames must be normalized at the database level too", () => {
    expect(() => insertTestUser(db, "Alice")).toThrow();
    expect(() => insertTestUser(db, "ab")).toThrow();
    insertTestUser(db, "alice_1");
    expect(() => insertTestUser(db, "alice_1")).toThrow(/UNIQUE/);
  });

  it("seat identity is exactly one of account or bot and must fit the match kind", () => {
    const user = insertTestUser(db, "seat_user");
    db.prepare(
      "INSERT INTO seasons (id, ruleset_version, name, starts_at, status, created_at) VALUES ('s1','duel-v1','S1',?, 'active', ?)",
    ).run(TEST_NOW, TEST_NOW);
    const insertMatch = (kind: string): string => {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO matches (id, kind, season_id, ruleset_version, seed, status, created_at, updated_at) VALUES (?, ?, 's1', 'duel-v1', 'seed', 'lobby', ?, ?)",
      ).run(id, kind, TEST_NOW, TEST_NOW);
      return id;
    };
    const seat = db.prepare(
      "INSERT INTO match_seats (match_id, seat, user_id, bot_strategy, bot_version, bot_config_json, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const hh = insertMatch("human-human");
    expect(() => seat.run(hh, "a", user, "random-v1", "1", "{}", TEST_NOW)).toThrow(); // both
    expect(() => seat.run(hh, "a", null, null, null, null, TEST_NOW)).toThrow(); // neither
    expect(() => seat.run(hh, "a", null, "random-v1", "1", "{}", TEST_NOW)).toThrow(/match kind/); // bot in human-human
    seat.run(hh, "a", user, null, null, null, TEST_NOW);
    expect(() => seat.run(hh, "b", user, null, null, null, TEST_NOW)).toThrow(/UNIQUE/); // same account twice
    expect(() => seat.run(hh, "c", insertTestUser(db, "other"), null, null, null, TEST_NOW)).toThrow();

    const hb = insertMatch("human-bot");
    seat.run(hb, "a", user, null, null, null, TEST_NOW);
    seat.run(hb, "b", null, "greedy-v1", "1", "{}", TEST_NOW);
    // Bots never move human Elo: rating events only for human-human matches.
    expect(() =>
      db
        .prepare(
          `INSERT INTO rating_events (match_id, user_id, season_id, ruleset_version, rating_before, rating_after, delta, outcome, algorithm, idempotency_key, created_at)
           VALUES (?, ?, 's1', 'duel-v1', 1000, 1012, 12, '1', 'elo-v1', ?, ?)`,
        )
        .run(hb, user, `${hb}:${user}`, TEST_NOW),
    ).toThrow(/human-human/);
    // Conservation check and idempotency key on human-human.
    expect(() =>
      db
        .prepare(
          `INSERT INTO rating_events (match_id, user_id, season_id, ruleset_version, rating_before, rating_after, delta, outcome, algorithm, idempotency_key, created_at)
           VALUES (?, ?, 's1', 'duel-v1', 1000, 1013, 12, '1', 'elo-v1', ?, ?)`,
        )
        .run(hh, user, `${hh}:${user}`, TEST_NOW),
    ).toThrow();
  });

  it("challenge attempts only reference ranked games, one per account and challenge", () => {
    const user = insertTestUser(db, "challenger");
    db.prepare(
      "INSERT INTO seasons (id, ruleset_version, name, starts_at, status, created_at) VALUES ('s1','ranked-v1','S1',?, 'active', ?)",
    ).run(TEST_NOW, TEST_NOW);
    db.prepare(
      "INSERT INTO challenges (id, season_id, ruleset_version, seed, move_cap, status, created_at) VALUES ('c1','s1','ranked-v1','seed',500,'open',?)",
    ).run(TEST_NOW);
    const attempt = db.prepare(
      "INSERT INTO challenge_attempts (id, challenge_id, user_id, game_id, status, created_at) VALUES (?, 'c1', ?, ?, 'in-progress', ?)",
    );
    const casual = insertTestGame(db, { ownerUserId: user });
    expect(() => attempt.run(randomUUID(), user, casual, TEST_NOW)).toThrow(/ranked game/);
    const ranked = insertTestGame(db, { mode: "ranked", ruleset: "ranked-v1", ownerUserId: user });
    attempt.run(randomUUID(), user, ranked, TEST_NOW);
    const ranked2 = insertTestGame(db, { mode: "ranked", ruleset: "ranked-v1", ownerUserId: user });
    expect(() => attempt.run(randomUUID(), user, ranked2, TEST_NOW)).toThrow(/UNIQUE/);
  });
});

describe("DB-08 decimal ordering", () => {
  it("orders huge scores by length then lexical value, never through REAL", () => {
    const db = track(openDatabase(dbPath));
    migrate(db);
    const two53 = (2n ** 53n).toString();
    const scores = [
      "0",
      "9",
      "10",
      two53,
      (2n ** 53n + 1n).toString(),
      (2n ** 64n).toString(),
      "1" + "0".repeat(500),
      "9".repeat(499),
      (2n ** 4096n).toString(),
      "123456789",
    ];
    for (const [i, score] of scores.entries()) {
      insertTestGame(db, { score, createdAt: `2026-10-12T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    const sql = `SELECT score FROM games WHERE mode = 'classic' AND ruleset_version = 'classic-v1'
                 ORDER BY ${decimalOrderBy("score")}, created_at ASC, id ASC`;
    const ordered = (db.prepare(sql).all() as { score: string }[]).map((r) => r.score);
    const expected = [...scores].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0));
    expect(ordered).toEqual(expected);
    expect([...scores].sort((a, b) => -compareCanonicalDecimal(a, b))).toEqual(expected);

    // The float path is demonstrably wrong: 2^53 and 2^53+1 collapse to the same REAL.
    const real = db
      .prepare("SELECT CAST(? AS REAL) = CAST(? AS REAL) AS same")
      .get(two53, (2n ** 53n + 1n).toString());
    expect(real).toEqual({ same: 1 });

    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain("games_casual_standings");
    expect(() => decimalOrderBy("score; DROP TABLE users")).toThrow();
  });
});

describe("single authoritative writer", () => {
  it("commits work, rolls back on error, and serializes FIFO", async () => {
    const db = track(openDatabase(dbPath));
    migrate(db);
    const writer = new DatabaseWriter(db);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        writer.run((tx) => {
          order.push(n);
          insertTestUser(tx, `user_${n}`);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
    await expect(
      writer.run((tx) => {
        insertTestUser(tx, "rolled_back");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE username_normalized = 'rolled_back'").get(),
    ).toEqual({ n: 0 });
    // Async work is refused so no transaction can span an await.
    await expect(writer.run(async () => 1)).rejects.toThrow(/synchronous/);
    expect(db.isTransaction).toBe(false);
  });

  it("returns DB_BUSY when the bounded queue is full", async () => {
    const db = track(openDatabase(dbPath));
    migrate(db);
    const writer = new DatabaseWriter(db, { maxQueue: 2 });
    const a = writer.run(() => 1);
    const b = writer.run(() => 2);
    const c = writer.run(() => 3);
    await expect(c).rejects.toBeInstanceOf(DbBusyError);
    await expect(Promise.all([a, b])).resolves.toEqual([1, 2]);
  });

  it("maps a competing process lock (SQLITE_BUSY after busy_timeout) to DB_BUSY", async () => {
    const db = track(openDatabase(dbPath, { busyTimeoutMs: 50 }));
    migrate(db);
    const other = track(openDatabase(dbPath, { busyTimeoutMs: 50 }));
    other.exec("BEGIN IMMEDIATE");
    const writer = new DatabaseWriter(db);
    await expect(writer.run((tx) => insertTestUser(tx, "blocked"))).rejects.toBeInstanceOf(DbBusyError);
    other.exec("ROLLBACK");
    await expect(writer.run((tx) => insertTestUser(tx, "unblocked"))).resolves.toBeTypeOf("string");
  });
});

describe("DB-05 backup and validated restore", () => {
  async function seeded(): Promise<DatabaseSync> {
    const { db } = await prepareDatabase(dbPath);
    track(db);
    const user = insertTestUser(db, "original");
    insertTestGame(db, { ownerUserId: user, score: (2n ** 200n).toString() });
    return db;
  }

  it("round-trips a WAL database through the backup API and keeps a safety copy", async () => {
    const db = await seeded();
    const backupPath = join(temp.dir, "backups", "snap.sqlite3");
    await backupDatabase(db, backupPath);
    await expect(backupDatabase(db, backupPath)).rejects.toThrow(/already exists/);
    insertTestUser(db, "after_backup");
    db.close();

    const result = await restoreDatabase(backupPath, dbPath);
    expect(result.report.appliedMigrations).toEqual(ALL_VERSIONS);
    expect(result.safetyBackup).not.toBeNull();

    const restored = track(openDatabase(dbPath));
    expect(restored.prepare("SELECT username_normalized FROM users ORDER BY 1").all()).toEqual([
      { username_normalized: "original" },
    ]);
    expect(restored.prepare("SELECT score FROM games").get()).toEqual({ score: (2n ** 200n).toString() });
    expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(migrate(restored)).toEqual([]);

    const safety = track(new DatabaseSync(result.safetyBackup as string, { readOnly: true }));
    expect(safety.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
  });

  it("rejects corrupt, foreign, future, and FK-broken inputs without touching the active database", async () => {
    const db = await seeded();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const before = fileSha(dbPath);

    const garbage = join(temp.dir, "garbage.sqlite3");
    writeFileSync(garbage, "this is not a database at all".repeat(100));

    const goodBackup = join(temp.dir, "good.sqlite3");
    const live = track(openDatabase(dbPath));
    await backupDatabase(live, goodBackup);
    live.close();
    const truncated = join(temp.dir, "truncated.sqlite3");
    const bytes = readFileSync(goodBackup);
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const flipped = join(temp.dir, "flipped.sqlite3");
    const corrupt = Buffer.from(bytes);
    for (let i = 4096; i < corrupt.length; i += 97) corrupt[i] = (corrupt[i] ?? 0) ^ 0xff;
    writeFileSync(flipped, corrupt);

    const foreign = join(temp.dir, "foreign.sqlite3");
    const f = new DatabaseSync(foreign);
    f.exec("CREATE TABLE notes (x TEXT)");
    f.close();

    const future = join(temp.dir, "future.sqlite3");
    const fut = track(openDatabase(future));
    migrate(fut);
    fut.prepare("INSERT INTO schema_migrations VALUES (42, 'future', ?, ?)").run("b".repeat(64), TEST_NOW);
    fut.close();

    const orphan = join(temp.dir, "orphan.sqlite3");
    const orp = track(openDatabase(orphan));
    migrate(orp);
    orp.exec("PRAGMA foreign_keys = OFF");
    orp.prepare("INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)").run(randomUUID(), TEST_NOW);
    orp.close();

    for (const bad of [
      garbage,
      truncated,
      flipped,
      foreign,
      future,
      orphan,
      join(temp.dir, "missing.sqlite3"),
    ]) {
      await expect(restoreDatabase(bad, dbPath), bad).rejects.toBeInstanceOf(RestoreError);
      expect(fileSha(dbPath)).toBe(before);
    }
    expect(readdirSync(temp.dir).filter((f) => f.includes(".restore-"))).toEqual([]);
    const check = track(openDatabase(dbPath));
    expect(check.prepare("SELECT username_normalized FROM users").all()).toEqual([
      { username_normalized: "original" },
    ]);
  });

  it("refuses to restore while the server holds the database lock; ignores stale locks", async () => {
    const db = await seeded();
    const backupPath = join(temp.dir, "snap.sqlite3");
    await backupDatabase(db, backupPath);
    db.close();
    const release = acquireDatabaseLock(dbPath);
    expect(() => acquireDatabaseLock(dbPath)).toThrow(/in use/);
    await expect(restoreDatabase(backupPath, dbPath)).rejects.toThrow(/stop it first/);
    release();
    expect(existsSync(lockPathFor(dbPath))).toBe(false);
    writeFileSync(lockPathFor(dbPath), JSON.stringify({ pid: 2_147_483_000, startedAt: TEST_NOW }));
    await expect(restoreDatabase(backupPath, dbPath)).resolves.toMatchObject({ restoredFrom: backupPath });
  });
});

describe("SEC-FIX-001 lock and restore hardening", () => {
  it("M4 boots on a fresh machine where the data directory does not exist yet", async () => {
    const fresh = join(temp.dir, "not", "yet", "created", "game.sqlite3");
    const release = acquireDatabaseLock(fresh);
    const { db, applied } = await prepareDatabase(fresh);
    track(db);
    expect(applied).toEqual(ALL_VERSIONS);
    expect(existsSync(lockPathFor(fresh))).toBe(true);
    release();
    expect(existsSync(lockPathFor(fresh))).toBe(false);
  });

  it("L4 releases its own lock after restoring; L6 refuses -wal sidecars and modified schemas", async () => {
    const { db } = await prepareDatabase(dbPath);
    track(db);
    insertTestUser(db, "original");
    const good = join(temp.dir, "good.sqlite3");
    await backupDatabase(db, good);
    db.close();

    writeFileSync(`${good}-wal`, "pretend live WAL");
    await expect(restoreDatabase(good, dbPath)).rejects.toThrow(/-wal exists/);
    rmSync(`${good}-wal`);

    const altered = join(temp.dir, "altered.sqlite3");
    writeFileSync(altered, readFileSync(good));
    const alt = new DatabaseSync(altered);
    alt.exec("DROP TRIGGER rating_events_human_only");
    alt.close();
    await expect(restoreDatabase(altered, dbPath)).rejects.toThrow(/schema does not match/);

    await expect(restoreDatabase(good, dbPath)).resolves.toMatchObject({ restoredFrom: good });
    expect(existsSync(lockPathFor(dbPath))).toBe(false);
  });
});

describe("SEC-FIX-001 L6 schema comparison", () => {
  it("tolerates extra data tables but rejects extra triggers and edited objects", async () => {
    const { db } = await prepareDatabase(dbPath);
    track(db);
    const base = join(temp.dir, "base.sqlite3");
    await backupDatabase(db, base);
    db.close();
    const variant = (name: string, sql: string): string => {
      const path = join(temp.dir, `${name}.sqlite3`);
      writeFileSync(path, readFileSync(base));
      const v = new DatabaseSync(path);
      v.exec(sql);
      v.close();
      return path;
    };
    const extraTable = variant("extra-table", "CREATE TABLE notes (x TEXT)");
    await expect(restoreDatabase(extraTable, dbPath)).resolves.toMatchObject({ restoredFrom: extraTable });
    const trigger = variant(
      "extra-trigger",
      "CREATE TRIGGER sneaky AFTER INSERT ON users BEGIN UPDATE users SET display_name = 'x'; END",
    );
    await expect(restoreDatabase(trigger, dbPath)).rejects.toThrow(/unexpected trigger sneaky/);
    const edited = variant(
      "edited",
      "DROP INDEX games_casual_standings; CREATE INDEX games_casual_standings ON games(score)",
    );
    await expect(restoreDatabase(edited, dbPath)).rejects.toThrow(/modified index games_casual_standings/);
  });
});

describe("OPS-10 restore over a corrupt live database", () => {
  it("moves the unreadable database aside byte-for-byte and installs the validated backup", async () => {
    const { db } = await prepareDatabase(dbPath);
    track(db);
    insertTestUser(db, "survivor");
    const backupPath = join(temp.dir, "good.sqlite3");
    await backupDatabase(db, backupPath);
    db.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    const garbage = Buffer.from("definitely not sqlite ".repeat(512));
    writeFileSync(dbPath, garbage);

    const result = await restoreDatabase(backupPath, dbPath);
    expect(result.safetyBackup).not.toBeNull();
    expect(readFileSync(result.safetyBackup as string).equals(garbage)).toBe(true);
    const restored = track(openDatabase(dbPath));
    expect(restored.prepare("SELECT username_normalized FROM users").all()).toEqual([
      { username_normalized: "survivor" },
    ]);
    expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});

describe("durability level", () => {
  it("defaults to WAL + synchronous NORMAL; FULL is opt-in", () => {
    const normal = track(openDatabase(dbPath));
    expect(normal.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    normal.close();
    const full = track(openDatabase(dbPath, { synchronous: "FULL" }));
    expect(full.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(full.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  });
});
