import { API_BASE, CSRF_HEADER, ERROR_CODES } from "@2048/contracts";
import type {
  ApiError,
  BotRunRequest,
  BotRunView,
  Challenge,
  ChangePasswordRequest,
  CreateGameRequest,
  CreateMatchRequest,
  DeleteProfileRequest,
  ErrorCode,
  EventsPage,
  ProfileStats,
  ReplaySummary,
  ForfeitRequest,
  GameView,
  HealthResponse,
  Identity,
  LeaderboardEntry,
  LeaderboardQuery,
  LoginRequest,
  MatchView,
  MoveRequest,
  MoveResponse,
  Page,
  PatchProfileRequest,
  RegisterRequest,
  ReplayView,
  UndoRequest,
} from "@2048/contracts";

/** Typed failure surfaced to UI code. `network` means the outcome of the request is unknown. */
export class ApiRequestError extends Error {
  readonly code: ErrorCode | "NETWORK" | "BAD_RESPONSE";
  readonly status: number;
  readonly requestId: string | null;
  readonly details: unknown;
  /** True when the server has no such route at all (generic "Not found"), as opposed to a missing resource. */
  routeMissing = false;
  constructor(
    code: ErrorCode | "NETWORK" | "BAD_RESPONSE",
    message: string,
    status: number,
    requestId: string | null,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
  get isNetwork(): boolean {
    return this.code === "NETWORK";
  }
}

export function isApiError(value: unknown): value is ApiRequestError {
  return value instanceof ApiRequestError;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export type ApiClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export { CSRF_HEADER };

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private csrfToken: string | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? API_BASE;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && this.csrfToken) headers[CSRF_HEADER] = this.csrfToken;
    let response: Response;
    try {
      const init: RequestInit = { method, headers, credentials: "same-origin" };
      if (body !== undefined) init.body = JSON.stringify(body);
      if (signal) init.signal = signal;
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new ApiRequestError("NETWORK", "Could not reach the local game server.", 0, null);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ApiRequestError("NETWORK", "The connection dropped while reading the response.", response.status, null);
    }
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        if (response.ok) throw new ApiRequestError("BAD_RESPONSE", "The server sent an unreadable response.", response.status, null);
      }
    }
    if (!response.ok) {
      const envelope = (json as Partial<ApiError> | null)?.error;
      if (envelope && isErrorCode(envelope.code)) {
        const failure = new ApiRequestError(
          envelope.code,
          typeof envelope.message === "string" ? envelope.message : envelope.code,
          response.status,
          typeof envelope.requestId === "string" ? envelope.requestId : null,
          envelope.details,
        );
        if (response.status === 404 && envelope.message === "Not found") failure.routeMissing = true;
        throw failure;
      }
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        // A dev proxy or gateway answered because the API process is not up; treat as unreachable.
        throw new ApiRequestError("NETWORK", "Could not reach the local game server.", response.status, null);
      }
      throw new ApiRequestError(
        response.status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR",
        `The server answered with status ${response.status}.`,
        response.status,
        null,
      );
    }
    return json as T;
  }

  private get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, undefined, signal);
  }

  private static query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
  }

  // --- health / auth / profile -------------------------------------------------
  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.get("/health", signal);
  }
  async me(signal?: AbortSignal): Promise<Identity> {
    const identity = await this.get<Identity>("/auth/me", signal);
    this.csrfToken = identity.csrfToken ?? null;
    return identity;
  }
  /** Server guest session (opaque HttpOnly cookie). Idempotent: returns the existing guest if one is present. */
  async guest(): Promise<Identity> {
    const identity = await this.request<Identity>("POST", "/auth/guest");
    this.csrfToken = identity.csrfToken ?? null;
    return identity;
  }
  profileStats(signal?: AbortSignal): Promise<ProfileStats> {
    return this.get("/profile/stats", signal);
  }
  async register(body: RegisterRequest): Promise<Identity> {
    const identity = await this.request<Identity>("POST", "/auth/register", body);
    this.csrfToken = identity.csrfToken ?? null;
    return identity;
  }
  async login(body: LoginRequest): Promise<Identity> {
    const identity = await this.request<Identity>("POST", "/auth/login", body);
    this.csrfToken = identity.csrfToken ?? null;
    return identity;
  }
  async logout(): Promise<void> {
    await this.request<unknown>("POST", "/auth/logout");
    this.csrfToken = null;
  }
  patchProfile(body: PatchProfileRequest): Promise<Identity> {
    return this.request("PATCH", "/profile", body);
  }
  changePassword(body: ChangePasswordRequest): Promise<unknown> {
    return this.request("POST", "/auth/password", body);
  }
  deleteProfile(body: DeleteProfileRequest): Promise<unknown> {
    return this.request("DELETE", "/profile", body);
  }
  exportProfile(): Promise<unknown> {
    return this.get("/profile/export");
  }

  // --- games --------------------------------------------------------------------
  createGame(body: CreateGameRequest): Promise<GameView> {
    return this.request("POST", "/games", body);
  }
  listGames(cursor?: string, signal?: AbortSignal, status: "active" | "completed" | "forfeited" | "all" = "active"): Promise<Page<GameView>> {
    return this.get(`/games${ApiClient.query({ status, cursor })}`, signal);
  }
  getGame(id: string, signal?: AbortSignal): Promise<GameView> {
    return this.get(`/games/${encodeURIComponent(id)}`, signal);
  }
  move(id: string, body: MoveRequest): Promise<MoveResponse> {
    return this.request("POST", `/games/${encodeURIComponent(id)}/moves`, body);
  }
  undo(id: string, body: UndoRequest): Promise<MoveResponse> {
    return this.request("POST", `/games/${encodeURIComponent(id)}/undo`, body);
  }
  forfeit(id: string, body: ForfeitRequest): Promise<GameView> {
    return this.request("POST", `/games/${encodeURIComponent(id)}/forfeit`, body);
  }
  gameEvents(id: string, cursor: number, limit = 100): Promise<EventsPage> {
    return this.get(`/games/${encodeURIComponent(id)}/events${ApiClient.query({ cursor, limit })}`);
  }

  // --- competition --------------------------------------------------------------
  leaderboard(query: LeaderboardQuery, signal?: AbortSignal): Promise<Page<LeaderboardEntry>> {
    return this.get(
      `/leaderboards${ApiClient.query({
        kind: query.kind,
        ruleset: query.ruleset,
        season: query.season,
        challenge: query.challenge,
        account: query.account,
        cursor: query.cursor,
        limit: query.limit,
      })}`,
      signal,
    );
  }
  replays(cursor?: string, signal?: AbortSignal): Promise<Page<ReplaySummary>> {
    return this.get(`/replays${ApiClient.query({ cursor })}`, signal);
  }
  challenges(signal?: AbortSignal): Promise<Challenge[] | Page<Challenge>> {
    return this.get("/challenges", signal);
  }
  startAttempt(challengeId: string): Promise<GameView> {
    return this.request("POST", `/challenges/${encodeURIComponent(challengeId)}/attempts`);
  }
  createMatch(body: CreateMatchRequest): Promise<MatchView> {
    return this.request("POST", "/matches", body);
  }
  joinMatch(id: string): Promise<MatchView> {
    return this.request("POST", `/matches/${encodeURIComponent(id)}/join`);
  }
  getMatch(id: string, signal?: AbortSignal): Promise<MatchView> {
    return this.get(`/matches/${encodeURIComponent(id)}`, signal);
  }

  // --- bots / replays -----------------------------------------------------------
  startBotRun(body: BotRunRequest): Promise<BotRunView> {
    return this.request("POST", "/bots/runs", body);
  }
  getBotRun(id: string, signal?: AbortSignal): Promise<BotRunView> {
    return this.get(`/bots/runs/${encodeURIComponent(id)}`, signal);
  }
  botRunAction(id: string, action: "pause" | "resume" | "step" | "cancel"): Promise<BotRunView> {
    return this.request("POST", `/bots/runs/${encodeURIComponent(id)}/${action}`);
  }
  cancelBotRun(id: string): Promise<BotRunView> {
    return this.botRunAction(id, "cancel");
  }
  getReplay(id: string, signal?: AbortSignal): Promise<ReplayView> {
    return this.get(`/replays/${encodeURIComponent(id)}`, signal);
  }
  importReplay(replay: unknown): Promise<unknown> {
    return this.request("POST", "/replays/import", replay);
  }
}

/** Shared singleton for the app; tests construct their own. */
export const api = new ApiClient();

/** Challenges endpoint may answer with a bare array or a Page; normalise. */
export function challengeItems(result: Challenge[] | Page<Challenge>): Challenge[] {
  return Array.isArray(result) ? result : result.items;
}

/** User-facing sentence plus recovery hint for an error code. */
export function describeError(error: unknown): { title: string; detail: string; action: string } {
  if (isApiError(error)) {
    if (error.routeMissing) {
      return {
        title: "Not available on this server yet",
        detail: "This feature's endpoint is not implemented by the running server.",
        action: "Nothing is lost. Try again after the server is updated.",
      };
    }
    switch (error.code) {
      case "NETWORK":
        return { title: "Cannot reach the game server", detail: error.message, action: "Check that the local server is running, then retry." };
      case "UNAUTHENTICATED":
        return { title: "You are signed out", detail: error.message, action: "Sign in again to continue." };
      case "FORBIDDEN":
        return { title: "Not allowed", detail: error.message, action: "This action is not available for your account or this mode." };
      case "NOT_FOUND":
        return { title: "Not found", detail: error.message, action: "It may have been deleted, or it belongs to another account." };
      case "REVISION_CONFLICT":
        return { title: "The game changed elsewhere", detail: error.message, action: "Reload the latest state and continue." };
      case "RATE_LIMITED":
        return { title: "Too many attempts", detail: error.message, action: "Wait a moment and try again." };
      case "DB_BUSY":
        return { title: "The database is busy", detail: error.message, action: "Nothing was lost. Retry in a few seconds." };
      case "RESOURCE_LIMIT":
        return { title: "A resource limit was reached", detail: error.message, action: "Your last valid state is preserved." };
      case "VALIDATION_ERROR":
      case "IMPORT_INVALID":
      case "REPLAY_VERSION_UNSUPPORTED":
        return { title: "That input was rejected", detail: error.message, action: "Fix the highlighted problem and try again." };
      default:
        return { title: "Something went wrong", detail: error.message, action: "Retry. If it keeps failing, check the server log." };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { title: "Something went wrong", detail: message, action: "Retry. If it keeps failing, reload the page." };
}
