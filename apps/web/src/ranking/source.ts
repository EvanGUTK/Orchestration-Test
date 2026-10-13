import type {
  ChallengeSummary,
  GameResponse,
  LeaderboardEntry,
  LeaderboardScope,
  Page,
} from "@g2048/contracts";
import type { ApiClient } from "../api/client.js";
import { isApiError } from "../api/client.js";

export type LeaderboardFilters = {
  readonly scope: LeaderboardScope;
  readonly ruleset?: string;
  readonly season?: string;
  readonly challenge?: string;
  readonly account?: string;
};

/** Contract-first access to rankings and challenges (BACKEND-004). */
export interface RankingSource {
  leaderboard(
    filters: LeaderboardFilters,
    cursor: string | null,
    limit?: number,
  ): Promise<Page<LeaderboardEntry>>;
  challenges(cursor: string | null): Promise<Page<ChallengeSummary>>;
  /** Official attempt, or resume of the existing one. */
  startAttempt(challengeId: string): Promise<GameResponse>;
}

export function leaderboardQueryString(
  filters: LeaderboardFilters,
  cursor: string | null,
  limit: number,
): string {
  const q = new URLSearchParams({ scope: filters.scope, limit: String(limit) });
  for (const key of ["ruleset", "season", "challenge", "account"] as const) {
    const value = filters[key]?.trim();
    if (value) q.set(key, value);
  }
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

export function apiRankingSource(api: ApiClient): RankingSource {
  return {
    leaderboard: (filters, cursor, limit = 25) =>
      api.request<Page<LeaderboardEntry>>(
        "GET",
        `/leaderboards?${leaderboardQueryString(filters, cursor, limit)}`,
      ),
    challenges: (cursor) =>
      api.request<Page<ChallengeSummary>>(
        "GET",
        `/challenges${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    startAttempt: (id) =>
      api.request<GameResponse>("POST", `/challenges/${encodeURIComponent(id)}/attempts`, {}),
  };
}

/** The endpoint doesn't exist on this server yet: show "not available yet", never sample data. */
export function isUnavailable(error: unknown): boolean {
  return isApiError(error) && error.code === "NOT_FOUND" && error.status === 404;
}
