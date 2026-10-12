// Per-test private application + SQLite database (never the lane's $DATABASE_PATH).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "@g2048/database";
import { buildApp } from "@g2048/server";

export type App = Awaited<ReturnType<typeof buildApp>>;

export type TestApp = {
  app: App;
  db: DatabaseSync;
  dataDir: string;
  dbPath: string;
  /** Closes app + db and deletes the temporary directory. */
  close(): Promise<void>;
};

/** Refuses any path that is, or lives under, the configured production data location. */
export function assertPrivatePath(path: string): void {
  const p = resolve(path).toLowerCase();
  for (const guarded of [process.env.DATABASE_PATH, process.env.DATA_DIR]) {
    if (
      guarded &&
      (p === resolve(guarded).toLowerCase() ||
        p.startsWith(resolve(guarded).toLowerCase() + "\\") ||
        p.startsWith(resolve(guarded).toLowerCase() + "/"))
    ) {
      throw new Error(`refusing to use production data path in tests: ${path}`);
    }
  }
}

export function makeTempDir(prefix = "g2048-int-"): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  assertPrivatePath(dir);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/** Opens (and migrates) a database at `dbPath`, then builds the app on it. */
export async function openTestApp(dbPath: string): Promise<{ app: App; db: DatabaseSync }> {
  assertPrivatePath(dbPath);
  const db = openDatabase(dbPath);
  migrate(db);
  const app = await buildApp({ db, webDist: null, logger: false });
  await app.ready();
  return { app, db };
}

export async function createTestApp(): Promise<TestApp> {
  const tmp = makeTempDir();
  const dbPath = join(tmp.dir, "game.sqlite3");
  const { app, db } = await openTestApp(dbPath);
  return {
    app,
    db,
    dataDir: tmp.dir,
    dbPath,
    async close() {
      await app.close();
      db.close();
      tmp.cleanup();
    },
  };
}
