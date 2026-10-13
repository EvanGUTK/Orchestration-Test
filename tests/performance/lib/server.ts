// Starts the PRODUCTION build (node apps/server/dist/main.js) on a spare 127.0.0.1 port with a private
// DATA_DIR/DATABASE_PATH under build/perf-data/. Never touches $DATABASE_PATH of the lane.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { REPO_ROOT, sleep } from "./report.js";

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => ok(port));
    });
  });
}

export function privateDataDir(label: string): string {
  const dir = resolve(REPO_ROOT, "build", "perf-data", `${label}-${Date.now()}`);
  const shared = process.env.DATABASE_PATH ? resolve(process.env.DATABASE_PATH).toLowerCase() : null;
  if (shared && resolve(dir, "game.sqlite3").toLowerCase() === shared) throw new Error("refusing shared DB");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const MAIN_JS = resolve(REPO_ROOT, "apps/server/dist/main.js");
export const CLI_JS = resolve(REPO_ROOT, "apps/server/dist/cli.js");

export function requireBuild(): void {
  if (!existsSync(MAIN_JS) || !existsSync(CLI_JS)) {
    throw new Error("production build missing (apps/server/dist): run `npm run build` first");
  }
}

export type ProdServer = {
  port: number;
  pid: number;
  dataDir: string;
  dbPath: string;
  child: ChildProcess;
  output(): string;
  stop(): Promise<void>;
};

export async function startProdServer(dataDir: string, timeoutMs = 30_000): Promise<ProdServer> {
  requireBuild();
  const dbPath = join(dataDir, "game.sqlite3");
  const port = await freePort();
  let out = "";
  const child = spawn(process.execPath, [MAIN_JS], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      API_PORT: String(port),
      DATA_DIR: dataDir,
      DATABASE_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => {
    out = (out + d.toString("utf8")).slice(-20_000);
  });
  child.stderr?.on("data", (d: Buffer) => {
    out = (out + d.toString("utf8")).slice(-20_000);
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited during boot (${child.exitCode}): ${out}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`server not healthy in ${timeoutMs}ms: ${out}`);
    }
    await sleep(100);
  }
  return {
    port,
    pid: child.pid ?? -1,
    dataDir,
    dbPath,
    child,
    output: () => out,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([exited, sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

/** Resident memory of another process in bytes (Windows: tasklist working set; Linux: /proc). null if unknown. */
export function processRss(pid: number): number | null {
  try {
    if (process.platform === "win32") {
      const csv = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
      });
      const m = /"([\d.,\s]+) K"\s*$/m.exec(csv.trim());
      if (!m?.[1]) return null;
      return Number.parseInt(m[1].replace(/[^\d]/g, ""), 10) * 1024;
    }
    const status = execFileSync("cat", [`/proc/${pid}/status`], { encoding: "utf8" });
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    return m?.[1] ? Number.parseInt(m[1], 10) * 1024 : null;
  } catch {
    return null;
  }
}
