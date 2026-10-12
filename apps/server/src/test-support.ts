import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { API_BASE } from "@g2048/contracts";
import { prepareDatabase } from "@g2048/database";
import { buildApp, type AppOptions } from "./app.js";
import { loopbackHostsFor } from "./security/origin.js";

export const TEST_HOST = "127.0.0.1:5591";
export const TEST_ORIGIN = `http://${TEST_HOST}`;

export type TestServer = {
  app: FastifyInstance;
  db: DatabaseSync;
  dir: string;
  dbPath: string;
  close: () => Promise<void>;
};

/** A fresh app over a private temporary database (never $DATABASE_PATH). */
export async function startTestServer(
  options: Partial<Omit<AppOptions, "db">> & {
    dir?: string;
    configure?: (app: FastifyInstance) => void;
  } = {},
): Promise<TestServer> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "g2048-server-"));
  const dbPath = join(dir, "game.sqlite3");
  const { db } = await prepareDatabase(dbPath);
  const { configure, dir: _dir, ...appOptions } = options;
  const app = await buildApp({ webDist: null, allowedHosts: loopbackHostsFor([5591]), ...appOptions, db });
  configure?.(app);
  await app.ready();
  return {
    app,
    db,
    dir,
    dbPath,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // best effort on Windows
  }
}

type Json = Record<string, unknown>;

/** Minimal browser-like client: keeps a cookie jar, sends same-origin headers and the CSRF token. */
export class TestClient {
  readonly cookies = new Map<string, string>();
  csrf = "";
  readonly app: FastifyInstance;
  origin: string | null = TEST_ORIGIN;
  host = TEST_HOST;

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  async request(
    method: InjectOptions["method"],
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const allHeaders: Record<string, string> = { host: this.host };
    if (this.origin) allHeaders.origin = this.origin;
    if (this.csrf) allHeaders["x-csrf-token"] = this.csrf;
    if (cookie) allHeaders.cookie = cookie;
    Object.assign(allHeaders, headers);
    const res = await this.app.inject({
      method,
      url: `${API_BASE}${path}`,
      headers: allHeaders,
      ...(body === undefined ? {} : { payload: body as Json }),
    });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() <= Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  /** GET /auth/me and remember the CSRF token. */
  async me(): Promise<Json> {
    const res = await this.request("GET", "/auth/me");
    const body = res.json() as Json;
    if (typeof body.csrfToken === "string") this.csrf = body.csrfToken;
    return body;
  }

  async register(
    username: string,
    password = "correct horse battery",
    displayName = username,
  ): Promise<LightMyRequestResponse> {
    if (!this.csrf) await this.me();
    const res = await this.request("POST", "/auth/register", { username, displayName, password });
    if (res.statusCode === 201) this.csrf = (res.json() as { csrfToken: string }).csrfToken;
    return res;
  }

  async login(username: string, password: string): Promise<LightMyRequestResponse> {
    if (!this.csrf) await this.me();
    const res = await this.request("POST", "/auth/login", { username, password });
    if (res.statusCode === 200) this.csrf = (res.json() as { csrfToken: string }).csrfToken;
    return res;
  }
}
