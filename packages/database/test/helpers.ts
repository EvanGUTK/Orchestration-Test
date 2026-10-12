import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { GameDb, migrate } from "../src/index.ts";

const dirs: string[] = [];
const dbs: GameDb[] = [];

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "2048-db-test-"));
  dirs.push(d);
  return d;
}

export function openMigrated(file = "game.sqlite3"): { db: GameDb; dir: string; path: string } {
  const dir = tempDir();
  const path = join(dir, file);
  const db = GameDb.open(path);
  dbs.push(db);
  migrate(db.raw);
  return { db, dir, path };
}

export function track(db: GameDb): GameDb {
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
