// OPS-10 (partial) | Migration failure injection + restore from backup — preserved last valid state and
// documented human recovery. Production build (dist/main.js + dist/cli.js) over a private data dir.
// Disk-full injection lives in tests/integration/db-06-busy.test.ts (SQLITE_FULL via max_page_count).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Direction, GameResponse, GameState, MoveResponse } from "@g2048/contracts";
import { legalMoves } from "@g2048/engine";
import { MIGRATIONS, prepareDatabase } from "@g2048/database";
import { Client } from "../../integration/helpers/http.js";
import { PERCENTILE_METHOD, REPO_ROOT, check } from "../lib/report.js";
import type { Scenario } from "../lib/report.js";
import { CLI_JS, privateDataDir, startProdServer } from "../lib/server.js";

function cli(dataDir: string, dbPath: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI_JS, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: dbPath, HOST: "127.0.0.1" },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim().slice(0, 600) };
}

async function playMoves(port: number, jar: Map<string, string> | null, gameId: string | null, n: number) {
  const c = new Client({ port });
  if (jar) for (const [k, v] of jar) c.jar.set(k, v);
  let id = gameId;
  let state: GameState;
  if (!id) {
    const g = await c.post<GameResponse>("/games", {
      mode: "practice",
      practice: { size: 6, seed: "ops10", undo: false },
    });
    if (g.status !== 201) throw new Error(`create ${g.status} ${g.text}`);
    id = g.json.game.id;
    state = g.json.state;
  } else {
    const g = await c.get<GameResponse>(`/games/${id}`);
    if (g.status !== 200) throw new Error(`get ${g.status} ${g.text}`);
    state = g.json.state;
  }
  for (let i = 0; i < n; i++) {
    const legal = legalMoves(state.board);
    const r = await c.post<MoveResponse>(`/games/${id}/moves`, {
      commandId: `ops10-${state.revision}-${i}-move`,
      expectedRevision: state.revision,
      direction: legal[i % legal.length] as Direction,
    });
    if (r.status !== 200) throw new Error(`move ${r.status} ${r.text}`);
    state = r.json.state;
  }
  return { jar: c.jar, gameId: id, state };
}

async function serverState(
  dataDir: string,
  jar: Map<string, string>,
  gameId: string,
): Promise<GameState | string> {
  let server;
  try {
    server = await startProdServer(dataDir, 20_000);
  } catch (e) {
    return `boot failed: ${(e as Error).message.slice(0, 300)}`;
  }
  try {
    const c = new Client({ port: server.port });
    for (const [k, v] of jar) c.jar.set(k, v);
    const g = await c.get<GameResponse>(`/games/${gameId}`);
    return g.status === 200 ? g.json.state : `GET ${g.status} ${g.text.slice(0, 200)}`;
  } finally {
    await server.stop();
  }
}

export const scenario: Scenario = {
  id: "OPS-10",
  title: "migration failure injection + CLI backup/restore (app stopped)",
  async run() {
    const t0 = performance.now();
    const dataDir = privateDataDir("ops10");
    const dbPath = join(dataDir, "game.sqlite3");
    const checks = [];
    const metrics: Record<string, unknown> = {};

    // 1. play, stop, back up (state S1)
    let server = await startProdServer(dataDir);
    const s1run = await playMoves(server.port, null, null, 15);
    await server.stop();
    const backup = join(dataDir, "backup-s1.sqlite3");
    const b = cli(dataDir, dbPath, "backup", backup);
    checks.push(
      check(
        "CLI backup with the app stopped",
        b.status === 0 && existsSync(backup),
        `exit ${b.status}: ${b.out}`,
      ),
    );

    // 2. more play after the backup (state S2 = last valid live state)
    server = await startProdServer(dataDir);
    const s2run = await playMoves(server.port, s1run.jar, s1run.gameId, 5);
    // 2b. restore must refuse while the server runs
    const busy = cli(dataDir, dbPath, "restore", backup);
    checks.push(
      check(
        "CLI restore refuses while the server is running",
        busy.status !== 0,
        `exit ${busy.status}: ${busy.out}`,
      ),
    );
    await server.stop();

    // 3. migration failure injection on the live DB (app stopped)
    // next contiguous version (the runner requires 1..N), so the failing SQL really executes
    const badVersion = MIGRATIONS.length + 1;
    const bad = {
      version: badVersion,
      name: "qa_injected_failure",
      sql: "CREATE TABLE qa_half (a INTEGER); INSERT INTO qa_missing_table VALUES (1);",
    };
    let migrationError = "none";
    try {
      const prepared = await prepareDatabase(dbPath, { migrations: [...MIGRATIONS, bad] });
      prepared.db.close();
    } catch (e) {
      migrationError = (e as Error).message.slice(0, 300);
    }
    const preflight = readdirSync(dataDir).filter((f) => f.includes(".pre-migrate-"));
    const inspect = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return {
          integrity: (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
            .integrity_check,
          half: !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'qa_half'").get(),
          v999: !!db.prepare("SELECT 1 AS x FROM schema_migrations WHERE version = ?").get(badVersion),
        };
      } finally {
        db.close();
      }
    };
    const { integrity, half, v999 } = inspect();
    checks.push(check("injected migration fails loudly", migrationError !== "none", migrationError));
    checks.push(
      check(
        "failed migration left no partial schema",
        !half && !v999,
        `qa_half table: ${half}, version ${badVersion} recorded: ${v999}`,
      ),
    );
    checks.push(check("integrity after failed migration", integrity === "ok", integrity));
    checks.push(
      check(
        "preflight backup taken before the upgrade attempt",
        preflight.length > 0,
        preflight.join(", ") || "none",
      ),
    );
    const afterMigration = await serverState(dataDir, s2run.jar, s2run.gameId);
    checks.push(
      check(
        "app boots after the failed upgrade and serves the last valid state (S2)",
        typeof afterMigration !== "string" && JSON.stringify(afterMigration) === JSON.stringify(s2run.state),
        typeof afterMigration === "string" ? afterMigration : `revision ${afterMigration.revision}`,
      ),
    );

    // 4. corrupt backup is refused; live DB untouched
    const corruptBackup = join(dataDir, "corrupt-backup.sqlite3");
    writeFileSync(corruptBackup, Buffer.alloc(64 * 1024, 0x5a));
    const before = execFileSync(process.execPath, [
      "-e",
      `process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(${JSON.stringify(dbPath)})).digest('hex'))`,
    ]).toString();
    const rc = cli(dataDir, dbPath, "restore", corruptBackup);
    const after = execFileSync(process.execPath, [
      "-e",
      `process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(${JSON.stringify(dbPath)})).digest('hex'))`,
    ]).toString();
    checks.push(
      check(
        "corrupt backup refused; live DB byte-identical",
        rc.status !== 0 && before === after,
        `exit ${rc.status}: ${rc.out}`,
      ),
    );

    // 5. live DB destroyed (simulated corruption) -> boot must not silently serve; restore S1 from backup via CLI
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    writeFileSync(dbPath, Buffer.alloc(256 * 1024, 0x42));
    const corruptBoot = await serverState(dataDir, s2run.jar, s2run.gameId);
    checks.push(
      check(
        "a corrupt live database is not silently served",
        typeof corruptBoot === "string",
        typeof corruptBoot === "string" ? corruptBoot : "server served a state from a corrupt file",
      ),
    );
    const restore = cli(dataDir, dbPath, "restore", backup);
    metrics.restoreOverCorruptLive = restore;
    let recovered: GameState | string = "not attempted";
    if (restore.status === 0) recovered = await serverState(dataDir, s1run.jar, s1run.gameId);
    checks.push(
      check(
        "CLI restore over a corrupt live database succeeds",
        restore.status === 0,
        `exit ${restore.status}: ${restore.out}`,
      ),
    );
    checks.push(
      check(
        "restored app serves exactly the backed-up state (S1)",
        typeof recovered !== "string" && JSON.stringify(recovered) === JSON.stringify(s1run.state),
        typeof recovered === "string" ? recovered : `revision ${recovered.revision}`,
      ),
    );
    metrics.files = readdirSync(dataDir).map((f) => basename(f));
    metrics.elapsedMs = Math.round(performance.now() - t0);
    return {
      id: "OPS-10",
      title: this.title,
      kind: "partial",
      dataset: `one 6x6 practice guest game: S1 = 15 moves (backed up), S2 = S1 + 5 moves; injected failing migration v${MIGRATIONS.length + 1} (qa_injected_failure)`,
      warmup: "none (fault-injection scenario, not a timing measurement)",
      rawSampleCount: 0,
      percentileMethod: `${PERCENTILE_METHOD} (no percentiles in this scenario)`,
      metrics,
      thresholds: [],
      correctness: checks,
      notMeasured: [
        "Disk-full during boot/migration (disk-full during writes: tests/integration/db-06-busy.test.ts)",
      ],
      notes: [
        "Human recovery (app stopped): npm run db:restore -- <backup-path>   e.g. the preflight file <db>.pre-migrate-v<from>-to-v<to>-<stamp> or a backup made with npm run db:backup -- <dest>",
        "restore validates integrity_check, foreign_key_check and the migration history of the candidate before replacing; it keeps a <db>.pre-restore-<stamp> safety copy when the current file is readable",
      ],
    };
  },
};
