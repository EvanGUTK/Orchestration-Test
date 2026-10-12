/**
 * Minimal cookie-jar HTTP client for /api/v1, used by acceptance, integration, fault and performance tests.
 * Written against docs/CONTRACTS.md + packages/contracts/src/api.ts (types are redeclared locally on purpose:
 * quality tests assert the wire format, they do not trust the implementation's own types).
 *
 * Open points reported to chief (defaults overridable by env until answered):
 *   CSRF header name   -> E2E_CSRF_HEADER (default "x-csrf-token"), token comes from Identity.csrfToken.
 */
export type Dir = "up" | "right" | "down" | "left";

export type ApiResult<T = unknown> = { status: number; headers: Headers; body: T; raw: string; ms: number };

export class ApiClient {
  readonly base: string;
  private jar = new Map<string, string>();
  csrfToken: string | null = null;
  origin: string;

  constructor(base: string) {
    this.base = base.replace(/\/$/, "");
    this.origin = new URL(this.base).origin;
  }

  cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clone(): ApiClient {
    const c = new ApiClient(this.base);
    c.jar = new Map(this.jar);
    c.csrfToken = this.csrfToken;
    return c;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: "application/json", origin: this.origin, ...extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (this.csrfToken && method !== "GET" && method !== "HEAD") {
      headers[process.env.E2E_CSRF_HEADER ?? "x-csrf-token"] ??= this.csrfToken;
    }
    const t0 = performance.now();
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const raw = await res.text();
    const ms = performance.now() - t0;
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/;\s*max-age=0/i.test(sc) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    let parsed: unknown = raw;
    try {
      parsed = raw === "" ? null : JSON.parse(raw);
    } catch {
      /* non-JSON body is returned as text */
    }
    return { status: res.status, headers: res.headers, body: parsed as T, raw, ms };
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = unknown>(path: string, body?: unknown, h?: Record<string, string>) {
    return this.request<T>("POST", path, body ?? {}, h);
  }

  /** Register + (if the server does not log in on register) log in. Stores the CSRF token from the identity. */
  async registerAndLogin(username: string, password = "correct horse battery staple 9", displayName = username): Promise<ApiResult<{ csrfToken?: string; userId?: string }>> {
    const reg = await this.post<{ csrfToken?: string }>("/auth/register", { username, displayName, password });
    if (reg.status >= 300) return reg;
    if (reg.body?.csrfToken) {
      this.csrfToken = reg.body.csrfToken;
    } else {
      const log = await this.post<{ csrfToken?: string }>("/auth/login", { username, password });
      if (log.body?.csrfToken) this.csrfToken = log.body.csrfToken;
      return log;
    }
    return reg;
  }
}

let cmdSeq = 0;
export function newCommandId(prefix = "cmd"): string {
  // The contract only requires a unique string per command; uuid keeps it realistic.
  return `${crypto.randomUUID()}-${prefix}-${cmdSeq++}`;
}
