import { ELO, RULESETS } from "@g2048/contracts";
import { fail } from "./errors.js";
import { startSeason } from "./season.js";
import type { RatingRecord, SeasonEvent, SeasonsState } from "./season.js";

/**
 * Challenge catalog policy.
 *
 * - Season IDs match SEASON_ID_PATTERN (no ':' so composed IDs are unambiguous).
 * - Challenge n (1-based) of season S has ID `ch-S-n` and seed `challenge:S:n`. Both are pure
 *   functions of (season, n), so every attempt, restart, and rebuild uses the same seed.
 *   Seeds are not secret: local users can read app files (PROJECT_SCOPE).
 * - Challenges always use the ranked-v1 ruleset (500-move cap, no undo).
 * - A challenge is open only while its season is the active season and it was not closed
 *   explicitly. Closed challenges reject new attempts; in-progress attempts may still resume
 *   and finish (see reduceChallengeAttempt).
 */

export const SEASON_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_CHALLENGES_PER_SEASON = 1000;

export type ChallengeDefinition = {
  readonly id: string;
  readonly season: string;
  readonly index: number;
  readonly seed: string;
  readonly rulesetVersion: string;
  readonly moveCap: number;
};

export type ChallengeStatus = "open" | "closed";

export function challengeId(season: string, index: number): string {
  assertSeasonId(season);
  assertIndex(index);
  return `ch-${season}-${index}`;
}

export function challengeSeed(season: string, index: number): string {
  assertSeasonId(season);
  assertIndex(index);
  return `challenge:${season}:${index}`;
}

export function buildChallengeCatalog(season: string, count: number): ChallengeDefinition[] {
  assertSeasonId(season);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CHALLENGES_PER_SEASON) {
    fail("VALIDATION_ERROR", `count must be an integer in 0..${MAX_CHALLENGES_PER_SEASON}`);
  }
  const rules = RULESETS["ranked-v1"];
  return Array.from({ length: count }, (_, i) => ({
    id: challengeId(season, i + 1),
    season,
    index: i + 1,
    seed: challengeSeed(season, i + 1),
    rulesetVersion: rules.version,
    moveCap: rules.moveCap,
  }));
}

/** open iff the challenge's season is the active season and the challenge is not closed explicitly. */
export function challengeStatus(
  challenge: ChallengeDefinition,
  seasons: SeasonsState,
  explicitlyClosed: ReadonlySet<string> = new Set(),
): ChallengeStatus {
  return seasons.activeSeason === challenge.season && !explicitlyClosed.has(challenge.id) ? "open" : "closed";
}

export type SeasonArchive = {
  readonly season: string;
  /** Final ladder, ordered rating desc, played desc, rulesetVersion asc, accountId asc. */
  readonly finalRatings: readonly RatingRecord[];
  readonly closedChallengeIds: readonly string[];
};

export type SeasonRollover = {
  readonly seasons: SeasonsState;
  readonly events: readonly SeasonEvent[];
  readonly archive: SeasonArchive | null;
  readonly challenges: readonly ChallengeDefinition[];
  /** Every account starts the new season at this rating (records are created lazily). */
  readonly initialRating: number;
};

/**
 * Season rollover: archives the active ladder (frozen snapshot + its challenges now closed),
 * starts `newSeason` via startSeason (ratings re-initialized at 1000 per account+season+ruleset),
 * and builds the new season's challenge catalog.
 */
export function rolloverSeason(
  seasons: SeasonsState,
  previousCatalog: readonly ChallengeDefinition[],
  newSeason: string,
  challengeCount: number,
): SeasonRollover {
  assertSeasonId(newSeason);
  const previous = seasons.activeSeason;
  if (previous !== null && previousCatalog.some((c) => c.season !== previous)) {
    fail("VALIDATION_ERROR", "previousCatalog must belong to the active season");
  }
  const challenges = buildChallengeCatalog(newSeason, challengeCount);
  const started = startSeason(seasons, newSeason);
  let archive: SeasonArchive | null = null;
  if (previous !== null) {
    const ladder = started.state.ladders[previous];
    const finalRatings = Object.values(ladder?.ratings ?? {}).sort(
      (x, y) =>
        y.rating - x.rating ||
        y.played - x.played ||
        codeUnits(x.rulesetVersion, y.rulesetVersion) ||
        codeUnits(x.accountId, y.accountId),
    );
    archive = { season: previous, finalRatings, closedChallengeIds: previousCatalog.map((c) => c.id) };
  }
  return {
    seasons: started.state,
    events: started.events,
    archive,
    challenges,
    initialRating: ELO.initialRating,
  };
}

function codeUnits(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function assertSeasonId(season: unknown): asserts season is string {
  if (typeof season !== "string" || !SEASON_ID_PATTERN.test(season)) {
    fail("VALIDATION_ERROR", "season id must match [A-Za-z0-9_-]{1,32}");
  }
}

function assertIndex(index: unknown): asserts index is number {
  if (
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    index < 1 ||
    index > MAX_CHALLENGES_PER_SEASON
  ) {
    fail("VALIDATION_ERROR", `challenge index must be an integer in 1..${MAX_CHALLENGES_PER_SEASON}`);
  }
}
