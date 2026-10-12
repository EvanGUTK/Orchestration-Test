import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Read-only inspection connection; always close it. */
export function withDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Every row of every table as one JSON string, for "is this secret/personal string stored anywhere" scans. */
export function dumpAllText(path: string): string {
  return withDb(path, (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    const parts: string[] = [];
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
      parts.push(JSON.stringify({ table: t.name, rows }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    }
    return parts.join("\n");
  });
}

export const REPO = resolve(new URL("../../../", import.meta.url).pathname);

/** Run the owner CLI (`node packages/database/src/cli.ts <args>`) against an explicit database path. */
export function runDbCli(databasePath: string, args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [resolve(REPO, "packages/database/src/cli.ts"), ...args], {
    cwd: REPO,
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export const fileSha = (p: string) => sha256(readFileSync(p));
