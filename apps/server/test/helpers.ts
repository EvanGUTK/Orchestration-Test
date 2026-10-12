import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { GameDb, migrate } from "@2048/database";
import { buildApp, loadConfig, type AppServices } from "../src/index.ts";

export const PORT = 5511;
export const HOST_HEADER = `127.0.0.1:${PORT}`;
export const hostFor = (port: number) => `127.0.0.1:${port}`;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

export type TestEnv = { app: FastifyInstance; services: AppServices; db: GameDb; dir: string; dbPath: string };

export async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000, everyMs = 25): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting; last value: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export type StartOptions = { now?: () => Date; listen?: boolean };

export async function startApp(env: Record<string, string> = {}, existing?: { dir: string }, extra: StartOptions = {}): Promise<TestEnv & { port: number }> {
  const dir = existing?.dir ?? mkdtempSync(join(tmpdir(), "2048-server-test-"));
  const dbPath = join(dir, "game.sqlite3");
  const config = loadConfig({
    DATABASE_PATH: dbPath, API_PORT: String(PORT), WEB_PORT: "5411", WEB_DIST: "",
    ARGON2_MEMORY_KIB: "64", ARGON2_TIME_COST: "1", ...env,
  });
  const db = GameDb.open(dbPath);
  migrate(db.raw);
  let port = PORT;
  const { app, services } = await buildApp({ db, config, boundPort: () => port, ...(extra.now ? { now: extra.now } : {}) });
  if (extra.listen) {
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as { port: number }).port;
  }
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    db.close();
    if (!existing) rmSync(dir, { recursive: true, force: true });
  });
  return { app, services, db, dir, dbPath, port };
}

export async function stopApp(t: TestEnv): Promise<void> {
  await t.app.close();
  t.db.close();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any; // test-only: response bodies are asserted structurally
export type ErrorBody = { error: { code: string; message: string; requestId: string; details?: Json } };
export type Res<T = Json> = { status: number; body: T; headers: Record<string, string | string[] | number | undefined> };

/** Cookie-jar HTTP client over fastify.inject, mimicking a same-origin browser. */
export class Client {
  readonly cookies = new Map<string, string>();
  csrf = "";
  ip = "127.0.0.1";
  readonly app: FastifyInstance;
  readonly origin: string | null;
  constructor(app: FastifyInstance, origin: string | null = ORIGIN) {
    this.app = app;
    this.origin = origin;
  }

  async raw<T = Json>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, opts: { csrf?: boolean } = {}): Promise<Res<T>> {
    const h: Record<string, string> = { host: HOST_HEADER, ...headers };
    if (this.origin && method !== "GET" && h.origin === undefined) h.origin = this.origin;
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.csrf && opts.csrf !== false && method !== "GET" && h["x-csrf-token"] === undefined) h["x-csrf-token"] = this.csrf;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      h["content-type"] ??= "application/json";
    }
    const res = await this.app.inject({ method: method as "GET", url, headers: h, payload, remoteAddress: this.ip });
    const set = res.headers["set-cookie"];
    for (const line of Array.isArray(set) ? set : set ? [set] : []) {
      const [pair] = line.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line) || value === "") this.cookies.delete(name!);
      else this.cookies.set(name!, value);
    }
    let parsed: unknown = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      /* keep text */
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers as Res['headers'] };
  }

  get = <T = Json>(url: string, headers?: Record<string, string>) => this.raw<T>("GET", `/api/v1${url}`, undefined, headers);
  post = <T = Json>(url: string, body?: unknown, headers?: Record<string, string>) => this.raw<T>("POST", `/api/v1${url}`, body ?? {}, headers);
  patch = <T = Json>(url: string, body?: unknown) => this.raw<T>("PATCH", `/api/v1${url}`, body ?? {});
  del = <T = Json>(url: string, body?: unknown) => this.raw<T>("DELETE", `/api/v1${url}`, body ?? {});

  async register(username: string, password = "correct horse battery", displayName = username): Promise<Res> {
    const r = await this.post("/auth/register", { username, displayName, password });
    if (r.status === 201) this.csrf = r.body.csrfToken;
    return r;
  }
  async login(username: string, password = "correct horse battery"): Promise<Res> {
    const r = await this.post("/auth/login", { username, password });
    if (r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }
  async guest(): Promise<Res> {
    const r = await this.post("/auth/guest");
    if (r.status === 201 || r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }
}

let counter = 0;
export const cmd = () => `cmd-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
