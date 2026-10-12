// DB-01 (fresh migration, repeated boot, upgrade) and DB-05 (backup then validated restore).
// Spec: docs/ARCHITECTURE.md "Database model" / "Save / replay / restart", PROJECT_SCOPE "Persistence".
// Every test uses a private temporary directory; the lane's $DATABASE_PATH is never touched.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, backupDatabase, migrate, openDatabase, restoreDatabase } from "@g2048/database";
import { makeTempDir, openTestApp } from "./helpers/app.js";
import { Client } from "./helpers/http.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRED_TABLES = [
  "schema_migrations",
  "users",
  "sessions",
  "profiles",
  "rulesets",
  "seasons",
  "challenges",
  "challenge_attempts",
  "games",
  "game_commands",
  "game_moves",
  "game_snapshots",
  "matches",
  "match_seats",
  "ratings",
  "rating_events",
  "bot_runs",
  "replay_exports",
];

// LIFO: closers registered after a temp dir run before that dir is deleted, even when a test throws.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
async function openTracked(path: string): Promise<Awaited<ReturnType<typeof openTestApp>>> {
  const opened = await openTestApp(path);
  cleanups.push(async () => {
    try {
      await opened.app.close();
    } catch {
      /* already closed */
    }
    try {
      opened.db.close();
    } catch {
      /* already closed */
    }
  });
  return opened;
}
function tempDir(): string {
  const t = makeTempDir("g2048-db-");
  cleanups.push(t.cleanup);
  return t.dir;
}
function track(db: DatabaseSync): DatabaseSync {
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });
  return db;
}
const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (r) => r.name,
  );
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Quality-owned marker table inside the private temp DB: lets backup/restore mechanics be checked
 *  independently of the backend's auth endpoints. */
function addMarker(db: DatabaseSync, value: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS qa_marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO qa_marker (value) VALUES (?)").run(value);
}
function markers(db: DatabaseSync): string[] {
  return (db.prepare("SELECT value FROM qa_marker ORDER BY id").all() as { value: string }[]).map(
    (r) => r.value,
  );
}

describe("DB-01 fresh migration, repeated boot, upgrade", () => {
  it("a fresh database migrates to the full schema with WAL, foreign keys and tracked checksums", () => {
    const db = track(openDatabase(join(tempDir(), "game.sqlite3")));
    const applied = migrate(db);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(tables(db)).toEqual(expect.arrayContaining(REQUIRED_TABLES));
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    const rows = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as {
      version: number;
      checksum: string;
    }[];
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, checksum: sha(m.sql) })));
  });

  it("exact values are never REAL: games.score is TEXT", () => {
    const db = track(openDatabase(join(tempDir(), "game.sqlite3")));
    migrate(db);
    const cols = db.prepare("PRAGMA table_info(games)").all() as { name: string; type: string }[];
    const score = cols.find((c) => c.name === "score");
    expect(score?.type.toUpperCase()).toBe("TEXT");
    for (const c of cols) expect(c.type.toUpperCase(), `games.${c.name}`).not.toMatch(/REAL|FLOA|DOUB/);
  });

  it("repeated boot applies nothing and keeps data intact; /ready reports ready", async () => {
    const dir = tempDir();
    const path = join(dir, "game.sqlite3");
    const first = await openTracked(path);
    addMarker(first.db, "before-restart");
    const reg = await new Client(first.app).register("persist_me", "Persist", "correct horse battery");
    await first.app.close();
    first.db.close();

    const second = await openTracked(path);
    expect(migrate(second.db)).toEqual([]);
    expect(markers(second.db)).toEqual(["before-restart"]);
    const ready = await second.app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(ready.statusCode).toBe(200);
    expect(JSON.parse(ready.body)).toMatchObject({ status: "ready", migrations: MIGRATIONS.length });
    // account data written through the API survives the restart
    expect([200, 201]).toContain(reg.status);
    expect((await new Client(second.app).login("persist_me", "correct horse battery")).status).toBe(200);
    await second.app.close();
  });

  it("a failing upgrade rolls back completely and leaves the database usable", () => {
    const db = track(openDatabase(join(tempDir(), "game.sqlite3")));
    migrate(db);
    addMarker(db, "pre-upgrade");
    const bad = {
      version: 9_999,
      name: "qa_broken_upgrade",
      sql: "CREATE TABLE qa_half_applied (id INTEGER); INSERT INTO table_that_does_not_exist VALUES (1);",
    };
    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow();
    expect(tables(db)).not.toContain("qa_half_applied");
    expect(db.prepare("SELECT 1 AS x FROM schema_migrations WHERE version = 9999").get()).toBeUndefined();
    expect(markers(db)).toEqual(["pre-upgrade"]);
    expect(migrate(db)).toEqual([]);
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe(
      "ok",
    );
  });

  it("an applied migration whose SQL changed is detected (checksum tracked)", () => {
    const db = track(openDatabase(join(tempDir(), "game.sqlite3")));
    migrate(db);
    const first = MIGRATIONS[0];
    if (!first) throw new Error("no migrations defined");
    expect(() => migrate(db, [{ ...first, sql: `${first.sql}\n-- edited` }, ...MIGRATIONS.slice(1)])).toThrow(
      /checksum/i,
    );
  });
});

describe("DB-05 backup then validated restore", () => {
  it("online WAL-safe backup captures committed data; restore brings it back exactly", async () => {
    const dir = tempDir();
    const live = join(dir, "game.sqlite3");
    const backup = join(dir, "backups", "snap.sqlite3");
    const db = track(openDatabase(live));
    migrate(db);
    addMarker(db, "in-backup");
    // data only in the WAL at backup time must still be captured
    expect(existsSync(`${live}-wal`)).toBe(true);
    await backupDatabase(db, backup);
    addMarker(db, "after-backup");
    db.close();

    restoreDatabase(backup, live);
    const restored = track(new DatabaseSync(live));
    expect(markers(restored)).toEqual(["in-backup"]);
    expect(
      (restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
    ).toBe("ok");
    expect(restored.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({
      n: MIGRATIONS.length,
    });
  });

  it("backup refuses to overwrite an existing file", async () => {
    const dir = tempDir();
    const db = track(openDatabase(join(dir, "game.sqlite3")));
    migrate(db);
    const dest = join(dir, "exists.sqlite3");
    writeFileSync(dest, "keep me");
    await expect(backupDatabase(db, dest)).rejects.toThrow();
    expect(readFileSync(dest, "utf8")).toBe("keep me");
  });

  it("a corrupt or foreign import never replaces the active database", () => {
    const dir = tempDir();
    const live = join(dir, "game.sqlite3");
    const db = track(openDatabase(live));
    migrate(db);
    addMarker(db, "precious");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const before = sha(readFileSync(live).toString("base64"));

    const garbage = join(dir, "garbage.sqlite3");
    writeFileSync(garbage, Buffer.from("this is not a sqlite database at all".repeat(100)));
    expect(() => restoreDatabase(garbage, live)).toThrow();

    const foreign = join(dir, "foreign.sqlite3");
    const f = new DatabaseSync(foreign);
    f.exec("CREATE TABLE other (x)");
    f.close();
    expect(() => restoreDatabase(foreign, live)).toThrow();

    expect(() => restoreDatabase(join(dir, "missing.sqlite3"), live)).toThrow();
    expect(sha(readFileSync(live).toString("base64"))).toBe(before);
    const check = track(new DatabaseSync(live));
    expect(markers(check)).toEqual(["precious"]);
  });

  it("full application state (an account) is recovered by restore", async () => {
    const dir = tempDir();
    const live = join(dir, "game.sqlite3");
    const a = await openTracked(live);
    await new Client(a.app).signUp("restore_me", "correct horse battery");
    const backup = join(dir, "snap.sqlite3");
    await backupDatabase(a.db, backup);
    await new Client(a.app).signUp("too_late", "correct horse battery");
    await a.app.close();
    a.db.close();

    restoreDatabase(backup, live);
    const b = await openTracked(live);
    expect((await new Client(b.app).login("restore_me", "correct horse battery")).status).toBe(200);
    expect((await new Client(b.app).login("too_late", "correct horse battery")).status).toBe(401);
    await b.app.close();
  });

  it("npm db:backup / db:restore CLI round-trips a private database", { timeout: 60_000 }, () => {
    const dir = tempDir();
    const live = join(dir, "game.sqlite3");
    const db = track(openDatabase(live));
    migrate(db);
    addMarker(db, "cli");
    db.close();
    const env = { ...process.env, DATABASE_PATH: live, DATA_DIR: dir };
    const cli = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ["--conditions=source", "--import", "tsx", "apps/server/src/cli.ts", ...args],
        {
          cwd: REPO_ROOT,
          env,
          encoding: "utf8",
        },
      );
    const dest = join(dir, "cli-backup.sqlite3");
    const b = cli("backup", dest);
    expect(b.status, b.stderr).toBe(0);
    expect(existsSync(dest)).toBe(true);

    const mutate = new DatabaseSync(live);
    mutate.prepare("INSERT INTO qa_marker (value) VALUES (?)").run("after-cli-backup");
    mutate.close();

    const r = cli("restore", dest);
    expect(r.status, r.stderr).toBe(0);
    const check = track(new DatabaseSync(live));
    expect(markers(check)).toEqual(["cli"]);

    const bad = cli("restore", join(dir, "nope.sqlite3"));
    expect(bad.status).not.toBe(0);
  });
});
