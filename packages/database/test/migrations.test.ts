import { describe, expect, it } from "vitest";
import { DomainError } from "@2048/contracts";
import {
  GameDb, LATEST_SCHEMA_VERSION, MigrationError, MIGRATIONS, WriteQueue, migrate, migrationChecksum, readAppliedMigrations,
} from "../src/index.ts";
import { openMigrated, tempDir, track } from "./helpers.ts";
import { join } from "node:path";

describe("migrations", () => {
  it("applies the schema once, records checksums, and is idempotent across reboots", () => {
    const { db } = openMigrated();
    const rows = readAppliedMigrations(db.raw);
    expect(rows).toHaveLength(MIGRATIONS.length);
    expect(rows[0]!.checksum).toBe(migrationChecksum(MIGRATIONS[0]!.sql));
    expect(db.raw.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const again = migrate(db.raw);
    expect(again.applied).toEqual([]);
    expect(again.currentVersion).toBe(LATEST_SCHEMA_VERSION);
  });

  it("upgrades a schema-1 database in place without losing data", () => {
    const dir = tempDir();
    const db = track(GameDb.open(join(dir, "v1.sqlite3")));
    migrate(db.raw, { migrations: MIGRATIONS.slice(0, 1) });
    db.raw.prepare("INSERT INTO guests (id, display_name, created_at) VALUES (?, 'g', 't')").run("g".repeat(36));
    expect(db.raw.pragma("user_version", { simple: true })).toBe(1);
    const r = migrate(db.raw);
    expect(r.applied).toEqual([2]);
    expect(db.raw.pragma("user_version", { simple: true })).toBe(2);
    expect(db.raw.prepare("SELECT count(*) AS n FROM guests").get()).toEqual({ n: 1 });
    expect(db.raw.prepare("SELECT count(*) AS n FROM replay_imports").get()).toEqual({ n: 0 });
  });

  it("uses WAL, foreign keys and a busy timeout on the live connection", () => {
    const { db } = openMigrated();
    expect(db.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.raw.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.raw.pragma("busy_timeout", { simple: true })).toBeGreaterThan(0);
  });

  it("creates every table from docs/ARCHITECTURE.md", () => {
    const { db } = openMigrated();
    const names = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of [
      "schema_migrations", "users", "sessions", "profiles", "rulesets", "seasons", "challenges", "challenge_attempts", "games",
      "game_commands", "game_moves", "game_snapshots", "matches", "match_seats", "ratings", "rating_events", "bot_runs", "replay_exports", "replay_imports",
    ]) expect(names).toContain(t);
  });

  it("refuses to run when an applied migration was edited (checksum mismatch)", () => {
    const { db } = openMigrated();
    db.raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
    expect(() => migrate(db.raw)).toThrow(MigrationError);
    try {
      migrate(db.raw);
    } catch (e) {
      expect((e as MigrationError).code).toBe("MIGRATION_CHECKSUM_MISMATCH");
    }
  });

  it("refuses a database from a newer build", () => {
    const { db } = openMigrated();
    db.raw.prepare("INSERT INTO schema_migrations VALUES (99, 'future', ?, 'x')").run("a".repeat(64));
    expect(() => migrate(db.raw)).toThrow(/does not know|newer/);
  });

  it("upgrades an older database and rolls a failing migration back completely", () => {
    const dir = tempDir();
    const db = track(GameDb.open(join(dir, "up.sqlite3")));
    const v1 = { version: 1, name: "one", sql: "CREATE TABLE a (x INTEGER) STRICT;" };
    const v2 = { version: 2, name: "two", sql: "CREATE TABLE b (y INTEGER) STRICT; INSERT INTO a VALUES (1);" };
    migrate(db.raw, { migrations: [v1] });
    db.raw.prepare("INSERT INTO a VALUES (7)").run();
    migrate(db.raw, { migrations: [v1, v2] });
    expect(db.raw.prepare("SELECT count(*) AS n FROM a").get()).toEqual({ n: 2 });

    const bad = { version: 3, name: "bad", sql: "CREATE TABLE c (z INTEGER) STRICT; INSERT INTO nonexistent VALUES (1);" };
    expect(() => migrate(db.raw, { migrations: [v1, v2, bad] })).toThrow(/rolled back/);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeUndefined();
    expect(readAppliedMigrations(db.raw)).toHaveLength(2);
  });
});

describe("single-writer wrapper", { timeout: 30_000 }, () => {
  it("rolls back the whole block on error", () => {
    const { db } = openMigrated();
    expect(() =>
      db.write((raw) => {
        raw.prepare("INSERT INTO guests (id, display_name, created_at) VALUES (?, 'g', 't')").run("g".repeat(36));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.raw.prepare("SELECT count(*) AS n FROM guests").get()).toEqual({ n: 0 });
  });

  it("serializes queued writes in order and fails fast with DB_BUSY when the queue is full", async () => {
    const { db } = openMigrated();
    const q = new WriteQueue(db, { maxPending: 3 });
    db.raw.exec("CREATE TABLE t (n INTEGER) STRICT");
    const order: number[] = [];
    const ps = [1, 2, 3].map((n) =>
      q.submit((raw) => {
        raw.prepare("INSERT INTO t VALUES (?)").run(n);
        order.push(n);
        return n;
      }),
    );
    const overflow = q.submit(() => 4);
    await expect(overflow).rejects.toMatchObject({ code: "DB_BUSY" });
    await expect(overflow).rejects.toBeInstanceOf(DomainError);
    expect(await Promise.all(ps)).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(q.pending).toBe(0);
  });

  it("maps SQLITE_BUSY from a competing writer to DB_BUSY", () => {
    const { db, path } = openMigrated();
    const other = track(GameDb.open(path, { busyTimeoutMs: 1 }));
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      expect(() => other.write(() => 1)).toThrowError(expect.objectContaining({ code: "DB_BUSY" }));
    } finally {
      db.raw.exec("ROLLBACK");
    }
  });
});

describe("preflight backup for destructive migrations", { timeout: 30_000 }, () => {
  it("backs up an existing database before a destructive migration, but not on a fresh one or a safe one", async () => {
    const { migrateWithPreflight } = await import("../src/index.ts");
    const dir = tempDir();
    const db = track(GameDb.open(join(dir, "pre.sqlite3")));
    const v1 = { version: 1, name: "one", sql: "CREATE TABLE a (x INTEGER) STRICT;" };
    const safe = { version: 2, name: "safe", sql: "CREATE TABLE b (y INTEGER) STRICT;" };
    const drop = { version: 3, name: "drop", sql: "DROP TABLE a;", destructive: true };
    const drop2 = { version: 2, name: "drop2", sql: "DROP TABLE a;", destructive: true };
    const reasons: string[] = [];
    const backup = async (reason: string) => {
      reasons.push(reason);
      return `/backups/${reason}.sqlite3`;
    };
    expect((await migrateWithPreflight(db.raw, { migrations: [v1, drop2], backup })).preflightBackup).toBeNull(); // fresh db
    expect(reasons).toEqual([]);
    const db2 = track(GameDb.open(join(dir, "pre2.sqlite3")));
    await migrateWithPreflight(db2.raw, { migrations: [v1], backup });
    expect((await migrateWithPreflight(db2.raw, { migrations: [v1, safe], backup })).preflightBackup).toBeNull();
    const r = await migrateWithPreflight(db2.raw, { migrations: [v1, safe, drop], backup });
    expect(r.preflightBackup).toBe("/backups/pre-migrate-v2-to-v3.sqlite3");
    expect(r.applied).toEqual([3]);
    // a failing destructive step rolls back and leaves the earlier version usable
    const db3 = track(GameDb.open(join(dir, "pre3.sqlite3")));
    await migrateWithPreflight(db3.raw, { migrations: [v1], backup });
    db3.raw.prepare("INSERT INTO a VALUES (7)").run();
    const broken = { version: 2, name: "broken", sql: "DROP TABLE a; SELECT * FROM missing_table;", destructive: true };
    await expect(migrateWithPreflight(db3.raw, { migrations: [v1, broken], backup })).rejects.toThrow(/rolled back/);
    expect(db3.raw.prepare("SELECT x FROM a").get()).toEqual({ x: 7 });
    expect(readAppliedMigrations(db3.raw)).toHaveLength(1);
  });
});
