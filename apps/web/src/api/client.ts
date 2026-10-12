import { API_BASE, ERROR_CODES } from "@g2048/contracts";
import type {
  AuthResponse,
  Direction,
  ErrorCode,
  GameResponse,
  GameSummary,
  MeResponse,
  MoveResponse,
  Page,
  PracticeOptions,
  Preferences,
  RevokeResponse,
} from "@g2048/contracts";

/** Client-side failure codes in addition to the contract's ErrorCode. */
export type ClientErrorCode = ErrorCode | "NETWORK_ERROR" | "BAD_RESPONSE";

export class ApiError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly retryAfterMs: number | null = null,
    readonly details: Record<string, unknown> | undefined = undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Worth retrying with the same request (and the same commandId). */
  get transient(): boolean {
    return this.code === "NETWORK_ERROR" || this.code === "DB_BUSY" || this.code === "RESOURCE_LIMIT";
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Human, actionable message for an error, always including the request ID when there is one. */
export function describeApiError(error: unknown): string {
  if (!isApiError(error)) return "Something went wrong.";
  const ref = error.requestId ? ` (request ${error.requestId})` : "";
  switch (error.code) {
    case "NETWORK_ERROR":
      return "Can't reach the local 2048 Infinite server. Check that it is running.";
    case "UNAUTHENTICATED":
      return "You are signed out. Sign in again to continue.";
    case "RATE_LIMITED":
      return `Too many attempts. Try again in ${formatWait(error.retryAfterMs)}.`;
    case "DB_BUSY":
      return `The local database is busy. Please retry in a moment${ref}.`;
    case "RESOURCE_LIMIT":
      return `The server hit a resource limit; your game is unchanged${ref}.`;
    case "NOT_FOUND":
      return `Not found — it may have been deleted${ref}.`;
    case "FORBIDDEN":
      return `That isn't allowed for this account${ref}.`;
    case "REVISION_CONFLICT":
      return `This game changed elsewhere (another tab?). Reload it to continue${ref}.`;
    default:
      return `${error.message}${ref}`;
  }
}

export function formatWait(ms: number | null): string {
  if (ms === null || ms <= 0) return "a moment";
  const seconds = Math.ceil(ms / 1000);
  if (seconds <= 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export type ConnectionState =
  | { readonly kind: "online" }
  | { readonly kind: "retrying"; readonly attempt: number; readonly of: number }
  | { readonly kind: "offline"; readonly message: string };

/** Shared connection indicator so any screen can show reconnect state (UI-05). */
export class ConnectionStatus {
  private state: ConnectionState = { kind: "online" };
  private readonly listeners = new Set<() => void>();
  get = (): ConnectionState => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(state: ConnectionState) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    for (const l of this.listeners) l();
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  fetch?: FetchLike;
  base?: string;
  connection?: ConnectionStatus;
};

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function parseRetryAfter(res: Response, details: Record<string, unknown> | undefined): number | null {
  const header = res.headers.get("retry-after");
  if (header && /^\d+$/.test(header.trim())) return Number.parseInt(header, 10) * 1000;
  const fromDetails = details?.retryAfterMs;
  return typeof fromDetails === "number" && Number.isFinite(fromDetails) ? fromDetails : null;
}

/**
 * Typed client for CONTRACT-001 `/api/v1`. Cookies are HttpOnly and never read here; the CSRF token
 * comes from GET /auth/me and is sent as `x-csrf-token` on every mutating request.
 */
export class ApiClient {
  private csrfToken: string | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  readonly connection: ConnectionStatus;

  constructor(options: ApiClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.base = options.base ?? API_BASE;
    this.connection = options.connection ?? new ConnectionStatus();
  }

  async request<T>(method: string, path: string, body?: unknown, retryCsrf = true): Promise<T> {
    const mutating = MUTATING.has(method);
    if (mutating && this.csrfToken === null) await this.me();
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (mutating && this.csrfToken) headers["x-csrf-token"] = this.csrfToken;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("NETWORK_ERROR", "Network request failed", 0, null);
    }
    // Any HTTP response means the server is reachable again.
    if (this.connection.get().kind === "offline") this.connection.set({ kind: "online" });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const envelope = (json as { error?: Record<string, unknown> } | null)?.error;
      const rawCode = typeof envelope?.code === "string" ? envelope.code : null;
      const code: ClientErrorCode =
        rawCode && (ERROR_CODES as readonly string[]).includes(rawCode)
          ? (rawCode as ErrorCode)
          : res.status >= 500
            ? "INTERNAL_ERROR"
            : "BAD_RESPONSE";
      const details =
        envelope?.details && typeof envelope.details === "object"
          ? (envelope.details as Record<string, unknown>)
          : undefined;
      const requestId =
        typeof envelope?.requestId === "string" ? envelope.requestId : res.headers.get("x-request-id");
      const message = typeof envelope?.message === "string" ? envelope.message : `HTTP ${res.status}`;
      // A stale CSRF token (e.g. after the session rotated) is refreshed once; safe because the
      // request was rejected before any effect, and game commands carry idempotent commandIds.
      if (res.status === 403 && mutating && retryCsrf && path !== "/auth/me") {
        this.csrfToken = null;
        await this.me();
        return this.request<T>(method, path, body, false);
      }
      throw new ApiError(code, message, res.status, requestId, parseRetryAfter(res, details), details);
    }
    return json as T;
  }

  async me(): Promise<MeResponse> {
    return this.adopt(await this.request<MeResponse>("GET", "/auth/me"));
  }

  /** Takes the (rotated) CSRF token from an AuthResponse/MeResponse. */
  private adopt(me: MeResponse): MeResponse {
    if (!me || typeof me.csrfToken !== "string") {
      throw new ApiError("BAD_RESPONSE", "Malformed identity response", 200, null);
    }
    this.csrfToken = me.csrfToken;
    return me;
  }

  /** Forget the CSRF token (the session changed); the next mutating call fetches a new one. */
  resetSession(): void {
    this.csrfToken = null;
  }

  /** 201 + AuthResponse (= MeResponse) with a rotated CSRF token (CONTRACT-001 C8). */
  async register(body: { username: string; displayName: string; password: string }): Promise<AuthResponse> {
    return this.adopt(await this.request<AuthResponse>("POST", "/auth/register", body));
  }
  async login(body: { username: string; password: string }): Promise<AuthResponse> {
    return this.adopt(await this.request<AuthResponse>("POST", "/auth/login", body));
  }
  /** `allSessions: true` clears every session of the account (C8). */
  logout(allSessions = false) {
    return this.request<RevokeResponse>("POST", "/auth/logout", allSessions ? { allSessions: true } : {});
  }
  changePassword(body: { currentPassword: string; newPassword: string }) {
    return this.request<RevokeResponse>("POST", "/auth/password", body);
  }
  patchProfile(body: { displayName?: string; preferences?: Preferences }) {
    return this.request<unknown>("PATCH", "/profile", body);
  }

  createGame(body: { mode: "classic"; seed?: string } | { mode: "practice"; practice: PracticeOptions }) {
    return this.request<GameResponse>("POST", "/games", body);
  }
  listGames(cursor: string | null, limit = 25) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.request<Page<GameSummary>>("GET", `/games?${q.toString()}`);
  }
  getGame(id: string) {
    return this.request<GameResponse>("GET", `/games/${encodeURIComponent(id)}`);
  }
  move(id: string, body: { commandId: string; expectedRevision: number; direction: Direction }) {
    return this.request<MoveResponse>("POST", `/games/${encodeURIComponent(id)}/moves`, body);
  }
  undo(id: string, body: { commandId: string; expectedRevision: number }) {
    return this.request<Partial<GameResponse> & Partial<MoveResponse>>(
      "POST",
      `/games/${encodeURIComponent(id)}/undo`,
      body,
    );
  }
  forfeit(id: string, body: { commandId: string; expectedRevision: number }) {
    return this.request<Partial<GameResponse> & Partial<MoveResponse>>(
      "POST",
      `/games/${encodeURIComponent(id)}/forfeit`,
      body,
    );
  }
}

/** Contract CommandId: 8-64 chars of [A-Za-z0-9_-]. randomUUID matches; fallback for non-secure contexts. */
export function newCommandId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const buf = new Uint8Array(16);
  c.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Exponential backoff schedule for transient failures (ms). */
export const RETRY_DELAYS_MS = [300, 800, 1600, 3200] as const;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `op` and retries it on transient failures (network, DB_BUSY, RESOURCE_LIMIT) with backoff,
 * reporting progress to the connection indicator. `op` must be idempotent (same commandId).
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  connection: ConnectionStatus,
  sleep: Sleep = realSleep,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await op();
      connection.set({ kind: "online" });
      return value;
    } catch (error) {
      if (!isApiError(error) || !error.transient) {
        if (isApiError(error) && error.code !== "NETWORK_ERROR") connection.set({ kind: "online" });
        throw error;
      }
      const delay = delays[attempt];
      if (delay === undefined) {
        connection.set({ kind: "offline", message: describeApiError(error) });
        throw error;
      }
      connection.set({ kind: "retrying", attempt: attempt + 1, of: delays.length });
      await sleep(delay);
    }
  }
}
