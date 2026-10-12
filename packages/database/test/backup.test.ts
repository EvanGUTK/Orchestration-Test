import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSIC_RULES, ENGINE_VERSION } from "@2048/contracts";
import { GameDb, RestoreError, backupDatabase, createRepos, restoreDatabase, validateDatabaseFile } from "../src/index.ts";
import { runCli } from "../src/cli.ts";
import { openMigrated, tempDir, track } from "./helpers.ts";

const NOW = "2026-10-12T10:00:00.000Z";

function populate(db: GameDb, score: string): string {
  return db.write((raw) => {
    const r = createRepos(raw);
    const userId = randomUUID();
    r.accounts.createUser({ id: userId, usernameNormalized: `u${userId.slice(0, 8)}`, displayName: "U", passwordHash: "h", createdAt: NOW, preferencesJson: "{}" });
    r.games.ensureRuleset(CLASSIC_RULES, "d".repeat(64), NOW);
    const cells = Array<string | null>(16).fill(null);
    cells[0] = "1";
    const id = randomUUID();
    r.games.insertGame({
      id, ownerUserId: userId, ownerGuestId: null, mode: "classic", seed: "s", challengeId: null, matchId: null, seat: null, createdAt: NOW,
      state: {
        schemaVersion: 1, engineVersion: ENGINE_VERSION, rulesetVersion: "classic-v1", board: { size: 4, cells }, score, acceptedMoves: 0,
        revision: 0, rng: { algorithm: "xoshiro128ss-v1", words: [1, 2, 3, 4] }, status: "active", celebrated2048: false,
      },
    });
    return id;
  });
}

const score = (db: GameDb, id: string) => (db.raw.prepare("SELECT score FROM games WHERE id = ?").get(id) as { score: string } | undefined)?.score;

describe("backup and restore", { timeout: 30_000 }, () => {
  it("backs up a live WAL database without a raw copy and restores full state", async () => {
    const { db, dir, path } = openMigrated();
    const id = populate(db, "123456789012345678901234567890");
    expect(existsSync(`${path}-wal`)).toBe(true); // unflushed WAL content must still be in the backup
    const backup = join(dir, "bk", "one.sqlite3");
    const result = await backupDatabase(db.raw, backup);
    expect(result.migrations).toBe(1);
    expect(existsSync(`${backup}.partial`)).toBe(false);
    expect(validateDatabaseFile(backup).ok).toBe(true);
    await expect(backupDatabase(db.raw, backup)).rejects.toThrow(/Refusing to overwrite/);

    // mutate the live DB, then restore the backup over it
    populate(db, "5");
    db.close();
    const restored = await restoreDatabase(backup, path);
    expect(restored.preRestoreBackup).not.toBeNull();
    const after = track(GameDb.open(path));
    expect(score(after, id)).toBe("123456789012345678901234567890");
    expect(after.raw.prepare("SELECT count(*) AS n FROM games").get()).toEqual({ n: 1 });
    expect(after.integrityCheck()).toEqual(["ok"]);
    // the pre-restore snapshot kept the mutated state
    const pre = track(GameDb.open(restored.preRestoreBackup!, { readonly: true }));
    expect(pre.raw.prepare("SELECT count(*) AS n FROM games").get()).toEqual({ n: 2 });
  });

  it("refuses corrupt, truncated, foreign and tampered input and leaves the active DB intact", async () => {
    const { db, dir, path } = openMigrated();
    const id = populate(db, "42");
    const good = join(dir, "good.sqlite3");
    await backupDatabase(db.raw, good);
    db.close();
    const activeBefore = readFileSync(path);

    const garbage = join(dir, "garbage.sqlite3");
    writeFileSync(garbage, Buffer.from("this is not a database ".repeat(100)));
    const truncated = join(dir, "truncated.sqlite3");
    copyFileSync(good, truncated);
    truncateSync(truncated, 300);
    const flipped = join(dir, "flipped.sqlite3");
    copyFileSync(good, flipped);
    const buf = readFileSync(flipped);
    for (let i = 4096; i < buf.length; i += 97) buf[i] = buf[i]! ^ 0xff;
    writeFileSync(flipped, buf);
    const tampered = join(dir, "tampered.sqlite3");
    copyFileSync(good, tampered);
    const raw = track(GameDb.open(tampered));
    raw.raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
    raw.close();
    const other = join(dir, "other.sqlite3");
    const o = track(GameDb.open(other));
    o.raw.exec("CREATE TABLE x (a INTEGER) STRICT");
    o.close();

    for (const bad of [garbage, truncated, flipped, tampered, other, join(dir, "missing.sqlite3")]) {
      await expect(restoreDatabase(bad, path), bad).rejects.toBeInstanceOf(RestoreError);
      expect(readFileSync(path).equals(activeBefore), `active changed after ${bad}`).toBe(true);
    }
    expect(readdirSync(dir).filter((f) => f.includes(".restore-"))).toEqual([]);
    const still = track(GameDb.open(path));
    expect(score(still, id)).toBe("42");
  });

  it("refuses to restore while another process has the database open", async () => {
    const { db, dir, path } = openMigrated();
    populate(db, "1");
    const good = join(dir, "good.sqlite3");
    await backupDatabase(db.raw, good);
    await expect(restoreDatabase(good, path)).rejects.toMatchObject({ code: "RESTORE_IN_USE" });
    expect(db.integrityCheck()).toEqual(["ok"]);
  });

  it("restore can recreate a missing active database", async () => {
    const { db, dir } = openMigrated();
    const id = populate(db, "77");
    const good = join(dir, "good.sqlite3");
    await backupDatabase(db.raw, good);
    const fresh = join(tempDir(), "nested", "game.sqlite3");
    const r = await restoreDatabase(good, fresh);
    expect(r.preRestoreBackup).toBeNull();
    expect(score(track(GameDb.open(fresh)), id)).toBe("77");
  });
});

describe("cli", { timeout: 30_000 }, () => {
  const run = async (args: string[], env: Record<string, string>) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, env, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("migrate -> backup -> restore round trip via DATABASE_PATH", async () => {
    const dir = tempDir();
    const env = { DATABASE_PATH: join(dir, "data", "game.sqlite3") };
    const m = await run(["migrate"], env);
    expect(m.code).toBe(0);
    expect(m.out).toMatch(/schema version 1/);
    expect((await run(["migrate"], env)).out).toMatch(/up to date/);

    const dest = join(dir, "snap.sqlite3");
    const b = await run(["backup", dest], env);
    expect(b.code).toBe(0);
    expect(existsSync(dest)).toBe(true);
    const auto = await run(["backup"], env);
    expect(auto.code).toBe(0);
    expect(readdirSync(join(dir, "data", "backups")).length).toBe(1);

    const r = await run(["restore", dest], env);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Restored/);
  });

  it("restore rejects a corrupt file with a non-zero exit code and a clear message", async () => {
    const dir = tempDir();
    const env = { DATABASE_PATH: join(dir, "game.sqlite3") };
    await run(["migrate"], env);
    const bad = join(dir, "bad.sqlite3");
    writeFileSync(bad, "nope".repeat(500));
    const r = await run(["restore", bad], env);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Restore refused/);
    expect(r.err).toMatch(/not modified/);
    expect((await run(["restore"], env)).code).toBe(2);
    expect((await run(["frobnicate"], env)).code).toBe(2);
    expect((await run(["migrate"], {})).code).toBe(2);
  });
});
