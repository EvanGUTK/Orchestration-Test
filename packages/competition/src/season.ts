import { ELO, ELO_ALGORITHM_VERSION } from "@g2048/contracts";
import type { RatingEvent } from "@g2048/contracts";
import { fail, requireId } from "./errors.js";
import { ratingIdempotencyKey } from "./match.js";

/**
 * Season policy and the human Elo ladder (pure reference model of the `seasons`, `ratings`
 * and `rating_events` tables).
 *
 * - Ratings are keyed by account + season + ruleset; an account with no record is rated
 *   ELO.initialRating (1000) in that season/ruleset.
 * - startSeason archives the previous active ladder (frozen, still readable) and opens a new
 *   ladder where every account starts again at 1000.
 * - applyRatingEvent is idempotent by `${matchId}:${accountId}`: replaying the same key (a
 *   duplicate or concurrent finish) is a no-op, so each account changes at most once per match.
 * - Only RatingEvents from human-human matches exist (the match reducer never produces them
 *   for bot matches), so bots can never move human Elo.
 */

export type LadderStatus = "active" | "archived";

export type RatingRecord = {
  readonly accountId: string;
  readonly season: string;
  readonly rulesetVersion: string;
  readonly rating: number;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
};

export type SeasonLadder = {
  readonly season: string;
  readonly status: LadderStatus;
  /** Keyed by ratingKey(accountId, season, rulesetVersion). */
  readonly ratings: Readonly<Record<string, RatingRecord>>;
  /** Idempotency keys of applied rating events. */
  readonly appliedEventKeys: Readonly<Record<string, true>>;
};

export type SeasonsState = {
  readonly activeSeason: string | null;
  /** Season IDs in the order they were started. */
  readonly order: readonly string[];
  readonly ladders: Readonly<Record<string, SeasonLadder>>;
};

export type SeasonEvent =
  | { readonly type: "season.archived"; readonly season: string }
  | { readonly type: "season.started"; readonly season: string; readonly initialRating: number };

export function initialSeasons(): SeasonsState {
  return { activeSeason: null, order: [], ladders: {} };
}

/** Unambiguous composite key (JSON array encoding cannot collide across fields). */
export function ratingKey(accountId: string, season: string, rulesetVersion: string): string {
  return JSON.stringify([accountId, season, rulesetVersion]);
}

export function startSeason(
  state: SeasonsState,
  seasonId: string,
): { readonly state: SeasonsState; readonly events: readonly SeasonEvent[] } {
  const id = requireId(seasonId, "seasonId");
  if (Object.hasOwn(state.ladders, id)) fail("SEASON_EXISTS", `season ${id} already exists`);
  const events: SeasonEvent[] = [];
  let ladders: Record<string, SeasonLadder> = { ...state.ladders };
  const previous = state.activeSeason === null ? undefined : state.ladders[state.activeSeason];
  if (previous !== undefined) {
    ladders = { ...ladders, [previous.season]: { ...previous, status: "archived" } };
    events.push({ type: "season.archived", season: previous.season });
  }
  ladders = { ...ladders, [id]: { season: id, status: "active", ratings: {}, appliedEventKeys: {} } };
  events.push({ type: "season.started", season: id, initialRating: ELO.initialRating });
  return { state: { activeSeason: id, order: [...state.order, id], ladders }, events };
}

/** Rating record for an account in a season/ruleset; defaults to a fresh 1000 record. */
export function getRatingRecord(
  state: SeasonsState,
  accountId: string,
  rulesetVersion: string,
  season: string | null = state.activeSeason,
): RatingRecord {
  if (season === null) fail("SEASON_NOT_ACTIVE", "no season has been started");
  const ladder = getLadder(state, season);
  const key = ratingKey(accountId, season, rulesetVersion);
  if (Object.hasOwn(ladder.ratings, key)) return ladder.ratings[key] as RatingRecord;
  return {
    accountId,
    season,
    rulesetVersion,
    rating: ELO.initialRating,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
  };
}

export function currentRating(
  state: SeasonsState,
  accountId: string,
  rulesetVersion: string,
  season: string | null = state.activeSeason,
): number {
  return getRatingRecord(state, accountId, rulesetVersion, season).rating;
}

export function hasAppliedRatingEvent(state: SeasonsState, season: string, idempotencyKey: string): boolean {
  return Object.hasOwn(getLadder(state, season).appliedEventKeys, idempotencyKey);
}

/**
 * Apply one rating event to its season ladder. Returns `applied: false` (and the identical
 * state object) when the idempotency key was already applied. Rejects events for archived or
 * unknown seasons, foreign algorithms, malformed keys, and stale `before` ratings.
 */
export function applyRatingEvent(
  state: SeasonsState,
  event: RatingEvent,
): { readonly state: SeasonsState; readonly applied: boolean } {
  const ladder = getLadder(state, event.season);
  if (event.idempotencyKey !== ratingIdempotencyKey(event.matchId, event.accountId)) {
    fail("VALIDATION_ERROR", "idempotencyKey must be `${matchId}:${accountId}`");
  }
  if (Object.hasOwn(ladder.appliedEventKeys, event.idempotencyKey)) return { state, applied: false };
  if (ladder.status !== "active") fail("SEASON_NOT_ACTIVE", `season ${event.season} is archived`);
  if (event.algorithm !== ELO_ALGORITHM_VERSION) fail("VALIDATION_ERROR", "unsupported rating algorithm");
  if (event.outcome !== 1 && event.outcome !== 0.5 && event.outcome !== 0) {
    fail("VALIDATION_ERROR", "outcome must be 1, 0.5, or 0");
  }
  if (!Number.isSafeInteger(event.delta) || event.after !== event.before + event.delta) {
    fail("VALIDATION_ERROR", "after must equal before + delta with an integer delta");
  }
  const record = getRatingRecord(state, event.accountId, event.rulesetVersion, event.season);
  if (record.rating !== event.before) {
    fail("RATING_STALE", `rating changed since the event was computed (${record.rating} != ${event.before})`);
  }
  const updated: RatingRecord = {
    ...record,
    rating: event.after,
    played: record.played + 1,
    won: record.won + (event.outcome === 1 ? 1 : 0),
    drawn: record.drawn + (event.outcome === 0.5 ? 1 : 0),
    lost: record.lost + (event.outcome === 0 ? 1 : 0),
  };
  const key = ratingKey(event.accountId, event.season, event.rulesetVersion);
  const nextLadder: SeasonLadder = {
    ...ladder,
    ratings: { ...ladder.ratings, [key]: updated },
    appliedEventKeys: { ...ladder.appliedEventKeys, [event.idempotencyKey]: true },
  };
  return { state: { ...state, ladders: { ...state.ladders, [event.season]: nextLadder } }, applied: true };
}

function getLadder(state: SeasonsState, season: string): SeasonLadder {
  if (!Object.hasOwn(state.ladders, season)) fail("SEASON_NOT_ACTIVE", `season ${season} does not exist`);
  return state.ladders[season] as SeasonLadder;
}
