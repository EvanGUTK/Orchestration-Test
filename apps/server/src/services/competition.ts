import { randomUUID } from "node:crypto";
import {
  botBoard, casualBoard, challengeBoard, createRepos, ladderBoard, type BoardQuery, type ChallengeRow, type GameDb, type WriteQueue,
} from "@2048/database";
import {
  CLASSIC_RULES, DUEL_RULES, RANKED_RULES, DomainError, type Challenge, type GameView, type LeaderboardEntry, type LeaderboardKind,
  type Page, type ProfileStats,
} from "@2048/contracts";
import { decideAttempt, seasonBounds } from "@2048/competition";
import { forbidden, notFound, validation } from "../errors.ts";
import type { Principal } from "./accounts.ts";
import { createGameRecord, type GameService } from "./games.ts";
import type { SeasonService } from "./seasons.ts";

export type LeaderboardParams = {
  kind: LeaderboardKind;
  ruleset?: string | undefined;
  season?: string | undefined;
  challenge?: string | undefined;
  account?: string | undefined;
  cursor?: string | undefined;
  limit: number;
};

const REASON_TEXT: Record<string, string> = {
  guest: "Guests cannot enter ranked challenges; create an account",
  "challenge-closed": "This challenge is closed",
  "attempt-consumed": "Your official attempt for this challenge is already used",
  "ruleset-unsupported": "This challenge uses an unsupported ruleset",
};

function encodeAfter(c: { createdAt: string; id: string }): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf8").toString("base64url");
}
function decodeAfter(raw: string): { createdAt: string; id: string } {
  const [createdAt, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (extra !== undefined || !createdAt || !id || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(createdAt)) throw validation("Invalid cursor");
  return { createdAt, id };
}

export type CompetitionDeps = { db: GameDb; queue: WriteQueue; seasons: SeasonService; games: GameService; now?: () => Date };

export class CompetitionService {
  readonly #d: CompetitionDeps;

  constructor(deps: CompetitionDeps) {
    this.#d = deps;
  }

  #now(): string {
    return (this.#d.now?.() ?? new Date()).toISOString();
  }

  async listChallenges(
    principal: Principal | null,
    q: { cursor?: string | undefined; limit: number; season?: string | undefined; status?: "open" | "closed" | undefined },
  ): Promise<Page<Challenge>> {
    const current = await this.#d.seasons.current();
    return this.#d.db.read((raw) => {
      const c = createRepos(raw).competition;
      const rows = c.listChallenges({
        seasonId: q.season ?? current.id,
        status: q.status,
        after: q.cursor ? decodeAfter(q.cursor) : undefined,
        limit: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((ch) => this.#challengeView(c, ch, principal)),
        nextCursor: rows.length > q.limit && last ? encodeAfter(last) : null,
      };
    });
  }

  #challengeView(c: ReturnType<typeof createRepos>["competition"], ch: ChallengeRow, principal: Principal | null): Challenge {
    const attempt = principal?.kind === "user" ? c.attempt(ch.id, principal.userId) : undefined;
    return {
      id: ch.id,
      seasonId: ch.seasonId,
      rulesetVersion: ch.rulesetVersion,
      title: ch.title,
      moveCap: ch.moveCap,
      status: ch.status,
      ...(attempt ? { myAttempt: { gameId: attempt.gameId, status: attempt.status } } : {}),
    };
  }

  async startAttempt(principal: Principal, challengeId: string): Promise<{ game: GameView; created: boolean }> {
    await this.#d.seasons.current(); // roll the season first so stale challenges are already closed
    const at = this.#now();
    return this.#d.queue.submit((raw) => {
      const repos = createRepos(raw);
      const c = repos.competition;
      const ch = c.challenge(challengeId);
      if (!ch) throw notFound("Challenge not found");
      const existing = principal.kind === "user" ? c.attempt(ch.id, principal.userId) : undefined;
      const decision = decideAttempt({
        identityKind: principal.kind,
        challenge: { status: ch.status, rulesetVersion: ch.rulesetVersion },
        existing: existing ? { gameId: existing.gameId, status: existing.status } : null,
      });
      if (decision.action === "reject") throw forbidden(REASON_TEXT[decision.reason] ?? "Not allowed", { reason: decision.reason });
      if (decision.action === "resume") {
        const g = repos.games.get(decision.gameId);
        if (!g) throw new DomainError("INTERNAL_ERROR", "Attempt game is missing");
        return { game: this.#d.games.viewIn(raw, g), created: false };
      }
      if (principal.kind !== "user") throw forbidden("Guests cannot enter ranked challenges");
      const stored = createGameRecord(raw, {
        owner: { userId: principal.userId }, mode: "ranked", rules: RANKED_RULES, seed: ch.seed, at, challengeId: ch.id,
      });
      c.insertAttempt({ id: randomUUID(), challengeId: ch.id, accountId: principal.userId, gameId: stored.id, createdAt: at });
      return { game: this.#d.games.view(stored, 0), created: true };
    });
  }

  async leaderboard(p: LeaderboardParams): Promise<Page<LeaderboardEntry>> {
    const current = await this.#d.seasons.current();
    const season = p.season ?? current.id;
    let range: { from: string; to: string | null } | undefined;
    if (p.season !== undefined) {
      try {
        const b = seasonBounds(p.season);
        range = { from: b.startsAt, to: b.endsAt };
      } catch {
        throw validation("Invalid season id (expected like s2026-10)");
      }
    }
    return this.#d.db.read((raw) => {
      const c = createRepos(raw).competition;
      let board: BoardQuery | null;
      switch (p.kind) {
        case "casual":
          board = casualBoard(p.ruleset ?? CLASSIC_RULES.version, range);
          break;
        case "bot":
          board = botBoard(p.ruleset ?? DUEL_RULES.version, range);
          break;
        case "duel-elo":
          board = ladderBoard(season, p.ruleset ?? DUEL_RULES.version);
          break;
        case "challenge": {
          const ch = p.challenge ? c.challenge(p.challenge) : c.latestChallenge(season);
          if (p.challenge && !ch) throw notFound("Challenge not found");
          board = ch ? challengeBoard(ch.id) : null;
          break;
        }
      }
      if (!board) return { items: [], nextCursor: null };
      let result;
      try {
        result = c.page(board, { limit: p.limit, cursor: p.cursor, accountId: p.account, accountColumn: "account_id" });
      } catch (err) {
        if (err instanceof RangeError) throw validation("Invalid cursor");
        throw err;
      }
      const items: LeaderboardEntry[] = result.rows.map((r) => {
        const deleted = r.deleted_at !== null && r.deleted_at !== undefined;
        const base = {
          rank: r.rank,
          accountId: deleted ? null : ((r.account_id as string | null) ?? null),
          displayName: deleted ? "Deleted player" : (r.display_name as string),
          createdAt: r.created_at as string,
        };
        if (p.kind === "duel-elo") {
          return {
            ...base, rating: r.rating as number, played: r.played as number, won: r.won as number, drawn: r.drawn as number, lost: r.lost as number,
          };
        }
        return { ...base, score: r.score as string, maxExponent: r.max_exponent as string, gameId: r.game_id as string };
      });
      return { items, nextCursor: result.nextCursor };
    });
  }

  async profileStats(userId: string): Promise<ProfileStats> {
    const season = await this.#d.seasons.current();
    return this.#d.db.read((raw) => {
      const c = createRepos(raw).competition;
      const s = c.stats(userId);
      const rating = c.rating(userId, season.id, DUEL_RULES.version);
      const rankedHistory = s.rankedAttempts.map((a) => {
        const row = c.page(challengeBoard(a.challengeId), { limit: 1, accountId: userId, accountColumn: "account_id" }).rows[0];
        return { challengeId: a.challengeId, gameId: a.gameId, score: a.score, maxExponent: a.maxExponent, rank: row ? row.rank : null };
      });
      const byStrategy: Record<string, { runs: number; bestScore: string | null }> = {};
      let runs = 0;
      for (const b of s.bot) {
        byStrategy[b.strategy] = { runs: b.runs, bestScore: b.bestScore };
        runs += b.runs;
      }
      return {
        gamesPlayed: s.gamesPlayed,
        bestScore: s.best?.score ?? null,
        bestScoreGameId: s.best?.gameId ?? null,
        maxExponent: s.maxExponent,
        scoreDistribution: s.scoreDistribution.map((d) => ({ bucketLabel: `${d.digits}-digit scores`, count: d.count })),
        maxTileCounts: s.maxTileCounts,
        duels: { won: s.duels.won, drawn: s.duels.drawn, lost: s.duels.lost, rating: rating ? rating.rating : null },
        rankedHistory,
        bot: { runs, byStrategy },
      };
    });
  }

  exportProfile(principal: Principal): unknown {
    if (principal.kind !== "user") throw forbidden("Guests have no account data to export");
    return this.#d.db.read((raw) => {
      const data = createRepos(raw).exports.collect(principal.userId, { maxGames: 2000, maxMovesPerGame: 20_000 });
      if (!data) throw notFound("Account not found");
      const prefs = data.profile ? JSON.parse(data.profile.preferences as string) : null;
      return {
        format: "2048-infinite-profile-export",
        schemaVersion: 1,
        exportedAt: this.#now(),
        note: "Contains no credentials or session material. Scores and exponents are decimal strings.",
        account: data.account,
        preferences: prefs,
        profile: data.profile ? { gamesPlayed: data.profile.gamesPlayed, bestScore: data.profile.bestScore, bestExponent: data.profile.bestExponent } : null,
        games: data.games.map((g) =>
          (g.mode === "ranked" || g.mode === "duel") && g.status === "active" ? { ...g, seed: null } : g,
        ),
        challengeAttempts: data.attempts,
        ratings: data.ratings,
        ratingEvents: data.ratingEvents,
        matches: data.matches,
        botRuns: data.botRuns,
      };
    });
  }
}
