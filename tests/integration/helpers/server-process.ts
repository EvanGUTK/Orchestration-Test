// Runs the real server (apps/server/src/main.ts via tsx) as a child process on an ephemeral 127.0.0.1
// port over a private database, so tests can hard-kill it (DB-02) and restart it.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPrivatePath } from "./app.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export type ServerProcess = {
  port: number;
  dbPath: string;
  child: ChildProcess;
  output(): string;
  /** Hard kill (TerminateProcess on Windows, SIGKILL elsewhere): no graceful shutdown. */
  kill(): Promise<void>;
  /** Graceful stop. */
  stop(): Promise<void>;
};

export async function startServerProcess(dataDir: string, timeoutMs = 30_000): Promise<ServerProcess> {
  const dbPath = join(dataDir, "game.sqlite3");
  assertPrivatePath(dbPath);
  const port = await freePort();
  let out = "";
  const child = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", "apps/server/src/main.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        API_PORT: String(port),
        DATA_DIR: dataDir,
        DATABASE_PATH: dbPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited during boot (${child.exitCode}):\n${out}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (r.status === 200) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`server did not become healthy in ${timeoutMs}ms:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    dbPath,
    child,
    output: () => out,
    async kill() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    },
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}
