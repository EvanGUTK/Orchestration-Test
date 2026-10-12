// Cookie-jar + CSRF client over Fastify inject, per CONTRACT-001 "HTTP / WebSocket / DB":
// mutating requests carry a same-origin `Origin` and `x-csrf-token` (from GET /auth/me);
// cookies `sid` (account) and `gid` (guest) are HttpOnly; SameSite=Strict; Path=/.
import { API_BASE } from "@g2048/contracts";
import type { MeResponse } from "@g2048/contracts";
import type { App } from "./app.js";

export const HOST = "127.0.0.1:5512";
export const ORIGIN = `http://${HOST}`;
export const FOREIGN_ORIGIN = "http://evil.example";

export type ParsedCookie = { name: string; value: string; attributes: Record<string, string | true> };

export type Res<T = unknown> = {
  status: number;
  json: T;
  text: string;
  headers: Record<string, string | string[] | number | undefined>;
  cookies: ParsedCookie[];
};

export function parseSetCookie(header: string): ParsedCookie {
  const [pair = "", ...attrs] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const attributes: Record<string, string | true> = {};
  for (const a of attrs) {
    const i = a.indexOf("=");
    if (i < 0) attributes[a.toLowerCase()] = true;
    else attributes[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

export type SendOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  /** undefined: same-origin Origin header; null: omit Origin; string: send that Origin. */
  origin?: string | null;
  /** undefined: send the session CSRF token on mutating requests; false: omit; string: send that value. */
  csrf?: string | false;
  host?: string;
  remoteAddress?: string;
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** One browser profile: its own cookie jar and CSRF token. */
export class Client {
  readonly jar = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(private readonly app: App) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async send<T = unknown>(method: string, path: string, opts: SendOptions = {}): Promise<Res<T>> {
    const upper = method.toUpperCase();
    const headers: Record<string, string> = { host: opts.host ?? HOST, ...opts.headers };
    if (MUTATING.has(upper)) {
      if (opts.origin === undefined) headers.origin = ORIGIN;
      else if (opts.origin !== null) headers.origin = opts.origin;
      if (opts.csrf === undefined) {
        // GET /auth/me may set the guest `gid` cookie together with the token it belongs to.
        if (this.csrfToken === null) await this.refreshCsrf();
        if (this.csrfToken !== null) headers["x-csrf-token"] = this.csrfToken;
      } else if (opts.csrf !== false) headers["x-csrf-token"] = opts.csrf;
    }
    // Read the jar only after every awaited step above, so cookies set by refreshCsrf() are sent.
    if (this.jar.size) headers.cookie = this.cookieHeader();
    const url = path.startsWith("/api/") ? path : `${API_BASE}${path}`;
    const res = await this.app.inject({
      method: upper as "GET",
      url,
      headers,
      remoteAddress: opts.remoteAddress ?? "127.0.0.1",
      ...(opts.body === undefined
        ? {}
        : {
            payload: JSON.stringify(opts.body),
            headers: { ...headers, "content-type": "application/json" },
          }),
    });
    const raw = res.headers["set-cookie"];
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
    const cookies = list.map(parseSetCookie);
    for (const c of cookies) {
      const expired =
        c.attributes["max-age"] === "0" ||
        (typeof c.attributes.expires === "string" && Date.parse(c.attributes.expires) < Date.now());
      if (expired || c.value === "") this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
    let json: unknown;
    try {
      json = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, json: json as T, text: res.body, headers: res.headers, cookies };
  }

  get<T = unknown>(path: string, opts?: SendOptions) {
    return this.send<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, body?: unknown, opts: SendOptions = {}) {
    return this.send<T>("POST", path, { ...opts, body });
  }

  async refreshCsrf(): Promise<string | null> {
    const me = await this.send<MeResponse>("GET", "/auth/me");
    this.csrfToken = me.status === 200 && typeof me.json?.csrfToken === "string" ? me.json.csrfToken : null;
    return this.csrfToken;
  }

  async me(): Promise<Res<MeResponse>> {
    return this.get<MeResponse>("/auth/me");
  }

  async register(username: string, displayName: string, password: string): Promise<Res> {
    const r = await this.post("/auth/register", { username, displayName, password });
    this.csrfToken = null;
    return r;
  }

  async login(username: string, password: string, opts: SendOptions = {}): Promise<Res> {
    const r = await this.post("/auth/login", { username, password }, opts);
    this.csrfToken = null;
    return r;
  }

  async logout(): Promise<Res> {
    const r = await this.post("/auth/logout");
    this.csrfToken = null;
    return r;
  }

  /** Register then log in; throws with the response body when either step fails. */
  async signUp(username: string, password = "correct horse battery", displayName = username): Promise<void> {
    const reg = await this.register(username, displayName, password);
    if (reg.status !== 200 && reg.status !== 201)
      throw new Error(`register ${username}: ${reg.status} ${reg.text}`);
    const login = await this.login(username, password);
    if (login.status !== 200) throw new Error(`login ${username}: ${login.status} ${login.text}`);
  }
}

/** Public error envelope check (CONTRACT-001 errors.ts): code/message/requestId, no stack. */
export function expectErrorEnvelope(res: Res, code?: string): void {
  const body = res.json as { error?: { code?: unknown; message?: unknown; requestId?: unknown } } | undefined;
  if (!body?.error) throw new Error(`expected error envelope, got ${res.status} ${res.text}`);
  if (typeof body.error.message !== "string" || typeof body.error.requestId !== "string") {
    throw new Error(`malformed error envelope: ${res.text}`);
  }
  if (code !== undefined && body.error.code !== code)
    throw new Error(`expected ${code}, got ${String(body.error.code)}`);
  if (/\bat .+:\d+:\d+/.test(res.text) || /stack/i.test(res.text))
    throw new Error(`stack trace leaked: ${res.text}`);
}
