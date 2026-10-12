/**
 * Boots the PRODUCTION server entry (`node apps/server/src/main.ts`, i.e. what `npm start` runs) on a free
 * loopback port with a private temporary data directory. Supports SIGKILL + restart on the SAME database
 * for crash-recovery tests. Never touches $DATABASE_PATH of the chief's integration checkout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(new URL("../../../", import.meta.url).pathname);
/** E2E_SERVER_ENTRY lets quality smoke-test its own harness against a stand-in; default is the production entry. */
export const SERVER_ENTRY = process.env.E2E_SERVER_ENTRY ?? join(REPO_ROOT, "apps/server/src/main.ts");
export const serverAvailable = (): boolean => existsSync(SERVER_ENTRY);

export async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

export type ServerHandle = {
  baseUrl: string;
  port: number;
  dataDir: string;
  dbPath: string;
  child: () => ChildProcess;
  logs: () => string;
  kill: (signal?: NodeJS.Signals) => Promise<void>;
  restart: () => Promise<void>;
  stop: (opts?: { keepData?: boolean }) => Promise<void>;
};

async function waitHealthy(baseUrl: string, child: ChildProcess, timeoutMs: number, logs: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${logs()}`);
    try {
      const r = await fetch(`${baseUrl}/api/v1/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server not healthy within ${timeoutMs}ms:\n${logs()}`);
}

export async function startServer(opts: { env?: Record<string, string>; dataDir?: string; timeoutMs?: number; port?: number } = {}): Promise<ServerHandle> {
  if (!serverAvailable()) throw new Error(`server entry missing: ${SERVER_ENTRY}`);
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "q2048-"));
  const dbPath = join(dataDir, "game.sqlite3");
  const port = opts.port ?? (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  let buf = "";
  let child!: ChildProcess;

  const launch = async () => {
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        // Both names are set because the port variable is an open question to chief; the server ignores the unused one.
        PORT: String(port),
        API_PORT: String(port),
        WEB_PORT: String(port),
        DATA_DIR: dataDir,
        DATABASE_PATH: dbPath,
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d) => (buf = (buf + d).slice(-20000)));
    child.stderr!.on("data", (d) => (buf = (buf + d).slice(-20000)));
    await waitHealthy(baseUrl, child, opts.timeoutMs ?? 30_000, () => buf);
  };

  const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r())));
  const kill = async (signal: NodeJS.Signals = "SIGKILL") => {
    const c = child;
    if (c.exitCode === null && c.signalCode === null) {
      c.kill(signal);
      await exited(c);
    }
  };
  await launch();
  return {
    baseUrl,
    port,
    dataDir,
    dbPath,
    child: () => child,
    logs: () => buf,
    kill,
    restart: async () => {
      await kill("SIGKILL");
      await launch();
    },
    stop: async (o = {}) => {
      const c = child;
      const hardStop = setTimeout(() => c.kill("SIGKILL"), 5_000);
      await kill("SIGTERM");
      clearTimeout(hardStop);
      if (!o.keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
