import { DomainError } from "@2048/contracts";
import { ELO_START_RATING } from "./elo.ts";

export type SeasonInfo = {
  id: string;
  /** Inclusive ISO-8601 UTC start. */
  startsAt: string;
  /** Exclusive ISO-8601 UTC end; null = open-ended. */
  endsAt: string | null;
  status: "active" | "archived";
};

/** Canonical monthly season id derived from an explicit instant (never reads the clock): `s2026-10`. */
export function seasonIdForInstant(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new DomainError("VALIDATION_ERROR", "invalid instant");
  const d = new Date(t);
  return `s${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** [start, end) of a monthly season id, as ISO strings. */
export function seasonBounds(seasonId: string): { startsAt: string; endsAt: string } {
  const m = /^s(\d{4})-(0[1-9]|1[0-2])$/.exec(seasonId);
  if (!m) throw new DomainError("VALIDATION_ERROR", "invalid season id");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { startsAt: new Date(Date.UTC(y, mo - 1, 1)).toISOString(), endsAt: new Date(Date.UTC(y, mo, 1)).toISOString() };
}

export function isInstantInSeason(season: Pick<SeasonInfo, "startsAt" | "endsAt">, iso: string): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t >= Date.parse(season.startsAt) && (season.endsAt === null || t < Date.parse(season.endsAt));
}

/** Only an active season accepts new ratings/attempts; archived ladders are read-only. */
export function acceptsNewResults(season: Pick<SeasonInfo, "status">): boolean {
  return season.status === "active";
}

export type LadderRow = { accountId: string; rating: number; played: number; won: number; drawn: number; lost: number };

/** Elo ladder order: rating desc, wins desc, games played asc, account id asc (total, stable). */
export function compareLadder(a: LadderRow, b: LadderRow): number {
  if (a.rating !== b.rating) return b.rating - a.rating;
  if (a.won !== b.won) return b.won - a.won;
  if (a.played !== b.played) return a.played - b.played;
  return a.accountId === b.accountId ? 0 : a.accountId < b.accountId ? -1 : 1;
}

export function rankLadder(rows: readonly LadderRow[]): (LadderRow & { rank: number })[] {
  return [...rows].sort(compareLadder).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Rollover: archive the old ladder (ranked) and initialise every account to the starting rating. */
export function rolloverSeason(rows: readonly LadderRow[]): {
  archived: (LadderRow & { rank: number })[];
  nextRatings: { accountId: string; rating: number }[];
} {
  const archived = rankLadder(rows);
  return { archived, nextRatings: archived.map((r) => ({ accountId: r.accountId, rating: ELO_START_RATING })) };
}

/** Rating for an account with no event in the season. */
export function initialRating(): number {
  return ELO_START_RATING;
}
