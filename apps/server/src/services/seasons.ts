import { createHash } from "node:crypto";
import { createRepos, type GameDb, type SeasonRow, type WriteQueue } from "@2048/database";
import { CLASSIC_RULES, DUEL_RULES, RANKED_RULES, SEAT_MOVE_CAP } from "@2048/contracts";
import { seasonBounds, seasonIdForInstant } from "@2048/competition";
import { rulesDigest, type GameService } from "./games.ts";

/** Challenges seeded per season. Seeds are derived (not secret): "seed confidentiality is not a security guarantee". */
export const CHALLENGES_PER_SEASON = 5;

export function challengeSeed(seasonId: string, n: number): string {
  return createHash("sha256").update(`2048-infinite/challenge/v1:${seasonId}:${n}`, "utf8").digest("hex").slice(0, 32);
}

/**
 * Owns the monthly season calendar. At boot (and lazily when the month changes) it ensures the official
 * rulesets, the current season, and its challenge catalog exist, archives older seasons and closes their
 * challenges. Pure id/bounds math comes from @2048/competition; the clock is injectable.
 */
export class SeasonService {
  readonly #db: GameDb;
  readonly #queue: WriteQueue;
  readonly #now: () => Date;
  #currentId: string | null = null;

  readonly #games: GameService;

  constructor(deps: { db: GameDb; queue: WriteQueue; games: GameService; now?: () => Date }) {
    this.#games = deps.games;
    this.#db = deps.db;
    this.#queue = deps.queue;
    this.#now = deps.now ?? (() => new Date());
  }

  /** Synchronous variant for boot (before the server listens). */
  ensureCurrentSync(): SeasonRow {
    const at = this.#now().toISOString();
    const row = this.#db.write((raw) => this.#ensure(raw, at));
    this.#currentId = row.id;
    void this.sweepStaleAttempts().catch(() => undefined);
    return row;
  }

  /** Abandoning forfeits: official attempts left active in a closed challenge are ended as forfeits. */
  async sweepStaleAttempts(): Promise<number> {
    const ids = this.#db.read((raw) => createRepos(raw).competition.staleAttemptGames());
    for (const id of ids) await this.#games.systemEnd(id, "forfeited", `season-close-${id}`);
    return ids.length;
  }

  /** The active season; creates/rolls it when the calendar month has changed since last call. */
  async current(): Promise<SeasonRow> {
    const at = this.#now().toISOString();
    const id = seasonIdForInstant(at);
    if (this.#currentId === id) {
      const row = this.#db.read((raw) => createRepos(raw).competition.season(id));
      if (row) return row;
    }
    const row = await this.#queue.submit((raw) => this.#ensure(raw, at));
    this.#currentId = row.id;
    await this.sweepStaleAttempts();
    return row;
  }

  #ensure(raw: Parameters<Parameters<GameDb["write"]>[0]>[0], at: string): SeasonRow {
    const repos = createRepos(raw);
    for (const rules of [CLASSIC_RULES, RANKED_RULES, DUEL_RULES]) repos.games.ensureRuleset(rules, rulesDigest(rules), at);
    const id = seasonIdForInstant(at);
    const b = seasonBounds(id);
    const c = repos.competition;
    c.ensureSeason({ id, rulesetVersion: RANKED_RULES.version, name: `Season ${id.slice(1)}`, startsAt: b.startsAt, endsAt: b.endsAt, status: "active" });
    c.rollSeason(id);
    for (let n = 1; n <= CHALLENGES_PER_SEASON; n++) {
      c.ensureChallenge({
        id: `${id}-c${n}`,
        seasonId: id,
        rulesetVersion: RANKED_RULES.version,
        title: `${id.slice(1)} Challenge ${n}`,
        seed: challengeSeed(id, n),
        moveCap: SEAT_MOVE_CAP,
        status: "open",
        createdAt: new Date(Date.parse(b.startsAt) + n * 1000).toISOString(),
      });
    }
    return c.season(id)!;
  }
}
