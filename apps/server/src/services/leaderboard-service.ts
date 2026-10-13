import {
  BOT_STRATEGIES,
  RULESETS,
  type BotStrategy,
  type LeaderboardEntry,
  type LeaderboardScope,
  type Page,
} from "@g2048/contracts";
import { computeBotLeague, type BotLeagueGame, type BotLeagueSeat } from "@g2048/competition";
import { competitionRepo, type BoardKey, type BoardRow } from "@g2048/database";
import { AppError } from "../http/errors.js";
import type { ServiceContext } from "./context.js";

export type LeaderboardQueryInput = {
  scope: LeaderboardScope;
  ruleset?: string | undefined;
  season?: string | undefined;
  challenge?: string | undefined;
  account?: string | undefined;
  cursor?: string | undefined;
  limit: number;
};

const DELETED_NAME = "Deleted player";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T>(cursor: string, valid: (v: unknown) => v is T): T {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (valid(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_ERROR", "Invalid cursor", { field: "cursor" });
}

const isBoardKey = (v: unknown): v is BoardKey => {
  const k = v as Partial<BoardKey> | null;
  return (
    typeof k === "object" &&
    k !== null &&
    typeof k.s === "string" &&
    typeof k.e === "string" &&
    typeof k.c === "string" &&
    typeof k.i === "string" &&
    Number.isSafeInteger(k.rank)
  );
};
type EloKey = { rating: number; userId: string; rank: number };
const isEloKey = (v: unknown): v is EloKey => {
  const k = v as Partial<EloKey> | null;
  return (
    typeof k === "object" &&
    k !== null &&
    Number.isSafeInteger(k.rating) &&
    typeof k.userId === "string" &&
    Number.isSafeInteger(k.rank)
  );
};
type OffsetKey = { o: number };
const isOffsetKey = (v: unknown): v is OffsetKey =>
  typeof v === "object" && v !== null && Number.isSafeInteger((v as OffsetKey).o) && (v as OffsetKey).o >= 0;

const empty: Page<LeaderboardEntry> = { items: [], nextCursor: null };

/**
 * Leaderboards (RANK-03, DB-08). Every board is a separate scope; practice/custom games and bot
 * results never enter human boards:
 *  - casual: each human account's best `classic` game on classic-v1 (guests and bots excluded);
 *  - challenge: completed official attempts only (forfeits consume an attempt but are not ranked);
 *  - duel-elo: the human ratings table for a season (default: the active season) and ruleset;
 *  - bot-league: computeBotLeague over finished bot-vs-bot matches.
 * Casual and challenge pages use keyset pagination over the total order (score length/value, max
 * exponent length/value, created_at, id) computed in SQL on canonical decimal TEXT (never REAL).
 */
export class LeaderboardService {
  readonly #ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.#ctx = ctx;
  }

  query(q: LeaderboardQueryInput): Page<LeaderboardEntry> {
    switch (q.scope) {
      case "casual":
        return this.#casual(q);
      case "challenge":
        return this.#challenge(q);
      case "duel-elo":
        return this.#elo(q);
      case "bot-league":
        return this.#botLeague(q);
      default:
        throw new AppError("VALIDATION_ERROR", "Unknown leaderboard scope");
    }
  }

  #casual(q: LeaderboardQueryInput): Page<LeaderboardEntry> {
    if (q.ruleset !== undefined && q.ruleset !== RULESETS["classic-v1"].version) return empty;
    if (q.challenge !== undefined) return empty;
    let from: string | undefined;
    let to: string | undefined;
    if (q.season !== undefined) {
      const season = competitionRepo.getSeason(this.#ctx.db, q.season);
      if (!season) return empty;
      from = season.startsAt;
      to = season.endsAt ?? undefined;
    }
    const after = q.cursor ? decode(q.cursor, isBoardKey) : null;
    const rows = competitionRepo.casualBoard(this.#ctx.db, {
      after,
      limit: q.limit + 1,
      ...(q.account ? { account: q.account } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    return this.#boardPage(rows, q.limit);
  }

  #challenge(q: LeaderboardQueryInput): Page<LeaderboardEntry> {
    const after = q.cursor ? decode(q.cursor, isBoardKey) : null;
    const rows = competitionRepo.challengeBoard(this.#ctx.db, {
      after,
      limit: q.limit + 1,
      ...(q.account ? { account: q.account } : {}),
      ...(q.challenge ? { challengeId: q.challenge } : {}),
      ...(q.season ? { seasonId: q.season } : {}),
      ...(q.ruleset ? { rulesetVersion: q.ruleset } : {}),
    });
    return this.#boardPage(rows, q.limit);
  }

  #boardPage(rows: BoardRow[], limit: number): Page<LeaderboardEntry> {
    const page = rows.slice(0, limit);
    const items = page.map((r): LeaderboardEntry => ({
      rank: r.rank,
      accountId: r.deletedAt ? null : r.userId,
      displayName: r.deletedAt ? DELETED_NAME : r.displayName,
      botStrategy: null,
      score: r.score,
      maxExponent: r.maxExponent === "" ? null : r.maxExponent,
      rating: null,
      gameId: r.gameId,
      createdAt: r.createdAt,
    }));
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encode({
            s: last.score,
            e: last.maxExponent,
            c: last.createdAt,
            i: last.id,
            rank: last.rank,
          } satisfies BoardKey)
        : null;
    return { items, nextCursor };
  }

  #elo(q: LeaderboardQueryInput): Page<LeaderboardEntry> {
    const rulesetVersion = q.ruleset ?? RULESETS["duel-v1"].version;
    const seasonId = q.season ?? competitionRepo.activeSeason(this.#ctx.db, rulesetVersion)?.id;
    if (!seasonId) return empty;
    const after = q.cursor ? decode(q.cursor, isEloKey) : null;
    const rows = competitionRepo.eloBoard(this.#ctx.db, {
      seasonId,
      rulesetVersion,
      after,
      limit: q.limit + 1,
      ...(q.account ? { account: q.account } : {}),
    });
    const page = rows.slice(0, q.limit);
    const items = page.map((r): LeaderboardEntry => ({
      rank: r.rank,
      accountId: r.deletedAt ? null : r.userId,
      displayName: r.deletedAt ? DELETED_NAME : r.displayName,
      botStrategy: null,
      score: null,
      maxExponent: null,
      rating: r.rating,
      gameId: null,
      createdAt: r.updatedAt,
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? encode({ rating: last.rating, userId: last.userId, rank: last.rank })
          : null,
    };
  }

  #botLeague(q: LeaderboardQueryInput): Page<LeaderboardEntry> {
    if (q.account !== undefined || q.challenge !== undefined) return empty; // bots have no accounts/challenges
    const seats = competitionRepo.botLeagueSeats(this.#ctx.db, {
      ...(q.season ? { seasonId: q.season } : {}),
      ...(q.ruleset ? { rulesetVersion: q.ruleset } : {}),
    });
    const byMatch = new Map<
      string,
      { a?: BotLeagueSeat; b?: BotLeagueSeat; outcome: BotLeagueGame["outcome"]; at: string }
    >();
    const firstSeen = new Map<string, string>();
    for (const row of seats) {
      if (!(BOT_STRATEGIES as readonly string[]).includes(row.strategy)) continue;
      const config = JSON.parse(row.configJson) as { nodeBudget?: unknown };
      const nodeBudget = typeof config.nodeBudget === "number" ? config.nodeBudget : 1;
      const seat: BotLeagueSeat = {
        kind: "bot",
        strategy: row.strategy as BotStrategy,
        botVersion: row.botVersion,
        nodeBudget,
        score: row.score,
        maxExponent: row.maxExponent,
      };
      const entry = byMatch.get(row.matchId) ?? { outcome: row.outcome, at: row.finalizedAt };
      entry[row.seat] = seat;
      byMatch.set(row.matchId, entry);
      const key = `${seat.strategy}@${seat.botVersion}/${seat.nodeBudget}`;
      if (!firstSeen.has(key)) firstSeen.set(key, row.finalizedAt);
    }
    const games: BotLeagueGame[] = [];
    for (const m of byMatch.values()) if (m.a && m.b) games.push({ a: m.a, b: m.b, outcome: m.outcome });
    const table = computeBotLeague(games);
    const offset = q.cursor ? decode(q.cursor, isOffsetKey).o : 0;
    const page = table.slice(offset, offset + q.limit);
    return {
      items: page.map((row): LeaderboardEntry => ({
        rank: row.rank,
        accountId: null,
        displayName: row.key,
        botStrategy: row.strategy,
        score: row.bestScore,
        maxExponent: row.bestMaxExponent,
        rating: null,
        gameId: null,
        createdAt: firstSeen.get(row.key) ?? "",
      })),
      nextCursor: offset + q.limit < table.length ? encode({ o: offset + q.limit }) : null,
    };
  }
}
