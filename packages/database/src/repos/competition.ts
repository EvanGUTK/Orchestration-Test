import type { Database as SqliteDatabase } from "better-sqlite3";
import type { MatchKind, MatchOutcome, MatchStatus, RatingEvent } from "@2048/contracts";
import { boardPage, type BoardQuery, type SortKey } from "./board.ts";

type Raw = Record<string, unknown>;

export type SeasonRow = { id: string; rulesetVersion: string; name: string; startsAt: string; endsAt: string | null; status: "upcoming" | "active" | "closed" };
export type ChallengeRow = { id: string; seasonId: string; rulesetVersion: string; title: string; seed: string; moveCap: number; status: "open" | "closed"; createdAt: string };
export type AttemptRow = {
  id: string; challengeId: string; accountId: string; gameId: string; status: "active" | "completed" | "forfeited";
  officialScore: string | null; officialMaxExponent: string | null; createdAt: string; finishedAt: string | null;
};
export type MatchRow = {
  id: string; seasonId: string; rulesetVersion: string; kind: MatchKind; seed: string; status: MatchStatus; outcome: MatchOutcome | null;
  createdBy: string | null; createdAt: string; finalizedAt: string | null; sequence: number;
};
export type SeatRow = { matchId: string; seat: 0 | 1; accountId: string | null; botConfigJson: string | null; gameId: string | null; terminalReason: "move-cap" | "dead" | "forfeit" | null };
export type RatingRow = { accountId: string; seasonId: string; rulesetVersion: string; rating: number; played: number; won: number; drawn: number; lost: number };

const season = (r: Raw): SeasonRow => ({
  id: r.id as string, rulesetVersion: r.ruleset_version as string, name: r.name as string, startsAt: r.starts_at as string,
  endsAt: (r.ends_at as string | null) ?? null, status: r.status as SeasonRow["status"],
});
const challenge = (r: Raw): ChallengeRow => ({
  id: r.id as string, seasonId: r.season_id as string, rulesetVersion: r.ruleset_version as string, title: r.title as string,
  seed: r.seed as string, moveCap: r.move_cap as number, status: r.status as ChallengeRow["status"], createdAt: r.created_at as string,
});
const attempt = (r: Raw): AttemptRow => ({
  id: r.id as string, challengeId: r.challenge_id as string, accountId: r.account_id as string, gameId: r.game_id as string,
  status: r.status as AttemptRow["status"], officialScore: (r.official_score as string | null) ?? null,
  officialMaxExponent: (r.official_max_exponent as string | null) ?? null, createdAt: r.created_at as string, finishedAt: (r.finished_at as string | null) ?? null,
});
const match = (r: Raw): MatchRow => ({
  id: r.id as string, seasonId: r.season_id as string, rulesetVersion: r.ruleset_version as string, kind: r.kind as MatchKind, seed: r.seed as string,
  status: r.status as MatchStatus, outcome: (r.outcome as MatchOutcome | null) ?? null, createdBy: (r.created_by as string | null) ?? null,
  createdAt: r.created_at as string, finalizedAt: (r.finalized_at as string | null) ?? null, sequence: r.sequence as number,
});
const seatRow = (r: Raw): SeatRow => ({
  matchId: r.match_id as string, seat: r.seat as 0 | 1, accountId: (r.account_id as string | null) ?? null,
  botConfigJson: (r.bot_config_json as string | null) ?? null, gameId: (r.game_id as string | null) ?? null,
  terminalReason: (r.terminal_reason as SeatRow["terminalReason"]) ?? null,
});
const rating = (r: Raw): RatingRow => ({
  accountId: r.account_id as string, seasonId: r.season_id as string, rulesetVersion: r.ruleset_version as string, rating: r.rating as number,
  played: r.played as number, won: r.won as number, drawn: r.drawn as number, lost: r.lost as number,
});

// ---- board definitions (exact decimal ordering) -------------------------------------------------------------------

const GAME_KEYS: SortKey[] = [
  { alias: "sl", dir: "DESC" }, { alias: "score", dir: "DESC" }, { alias: "el", dir: "DESC" },
  { alias: "me", dir: "DESC" }, { alias: "created_at", dir: "ASC" }, { alias: "id", dir: "ASC" },
];

/**
 * Casual board: every finished classic game (one entry per game, so a player can hold several places and
 * `account` filters become "my best games"). Total order: score, max exponent, then created_at and id.
 */
export function casualBoard(ruleset: string, range?: { from: string; to: string | null }): BoardQuery {
  const rangeSql = range ? ` AND g.created_at >= ?${range.to ? " AND g.created_at < ?" : ""}` : "";
  const rangeParams = range ? (range.to ? [range.from, range.to] : [range.from]) : [];
  return {
    sql: `SELECT g.id AS id, g.owner_user_id AS account_id, u.display_name AS display_name, u.deleted_at AS deleted_at, g.score AS score,
            g.max_exponent AS max_exponent, g.max_exponent AS me, g.created_at AS created_at, length(g.score) AS sl, length(g.max_exponent) AS el,
            g.id AS game_id
          FROM games g JOIN users u ON u.id = g.owner_user_id
          WHERE g.mode = 'classic' AND g.ruleset_version = ? AND g.status IN ('completed', 'forfeited')${rangeSql}`,
    params: [ruleset, ...rangeParams],
    keys: GAME_KEYS,
  };
}

/** Completed bot games (exhibition, league, duel seats); the label is the bot description. */
export function botBoard(ruleset: string, range?: { from: string; to: string | null }): BoardQuery {
  const rangeSql = range ? ` AND g.created_at >= ?${range.to ? " AND g.created_at < ?" : ""}` : "";
  const rangeParams = range ? (range.to ? [range.from, range.to] : [range.from]) : [];
  return {
    sql: `SELECT g.id AS id, NULL AS account_id, COALESCE(g.bot_label, 'Bot') AS display_name, NULL AS deleted_at, g.score AS score,
            g.max_exponent AS max_exponent, g.max_exponent AS me, g.created_at AS created_at, length(g.score) AS sl, length(g.max_exponent) AS el,
            g.id AS game_id
          FROM games g WHERE g.mode IN ('bot-exhibition', 'bot-league', 'bot-duel') AND g.status = 'completed' AND g.ruleset_version = ?${rangeSql}`,
    params: [ruleset, ...rangeParams],
    keys: GAME_KEYS,
  };
}

export function challengeBoard(challengeId: string): BoardQuery {
  return {
    sql: `SELECT a.id AS id, a.account_id AS account_id, u.display_name AS display_name, u.deleted_at AS deleted_at, a.official_score AS score,
            a.official_max_exponent AS max_exponent, a.official_max_exponent AS me, a.created_at AS created_at, a.game_id AS game_id,
            length(a.official_score) AS sl, length(a.official_max_exponent) AS el, a.rowid AS ord
          FROM challenge_attempts a JOIN users u ON u.id = a.account_id WHERE a.challenge_id = ? AND a.status = 'completed'`,
    params: [challengeId],
    keys: [
      { alias: "sl", dir: "DESC" }, { alias: "score", dir: "DESC" }, { alias: "el", dir: "DESC" }, { alias: "me", dir: "DESC" }, { alias: "ord", dir: "ASC" },
    ],
  };
}

export function ladderBoard(seasonId: string, ruleset: string): BoardQuery {
  return {
    sql: `SELECT r.account_id AS id, r.account_id AS account_id, u.display_name AS display_name, u.deleted_at AS deleted_at, r.rating AS rating,
            r.played AS played, r.won AS won, r.drawn AS drawn, r.lost AS lost, u.created_at AS created_at
          FROM ratings r JOIN users u ON u.id = r.account_id WHERE r.season_id = ? AND r.ruleset_version = ?`,
    params: [seasonId, ruleset],
    keys: [{ alias: "rating", dir: "DESC" }, { alias: "won", dir: "DESC" }, { alias: "played", dir: "ASC" }, { alias: "account_id", dir: "ASC" }],
  };
}

export type ProfileStatsRaw = {
  gamesPlayed: number;
  best: { score: string; gameId: string } | null;
  maxExponent: string | null;
  scoreDistribution: { digits: number; count: number }[];
  maxTileCounts: { exponent: string; count: number }[];
  duels: { won: number; drawn: number; lost: number };
  rankedAttempts: { challengeId: string; gameId: string; score: string; maxExponent: string; attemptId: string }[];
  bot: { strategy: string; runs: number; bestScore: string | null }[];
};

export function competitionRepo(db: SqliteDatabase) {
  const q = {
    seasonIns: db.prepare("INSERT OR IGNORE INTO seasons (id, ruleset_version, name, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, ?)"),
    seasonGet: db.prepare("SELECT * FROM seasons WHERE id = ?"),
    seasonActive: db.prepare("SELECT * FROM seasons WHERE status = 'active' ORDER BY starts_at DESC, id DESC LIMIT 1"),
    seasonsClose: db.prepare("UPDATE seasons SET status = 'closed' WHERE status = 'active' AND id <> ?"),
    challengesClose: db.prepare("UPDATE challenges SET status = 'closed' WHERE status = 'open' AND season_id <> ?"),
    seasonActivate: db.prepare("UPDATE seasons SET status = 'active' WHERE id = ? AND status = 'upcoming'"),
    chIns: db.prepare("INSERT OR IGNORE INTO challenges (id, season_id, ruleset_version, title, seed, move_cap, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    chGet: db.prepare("SELECT * FROM challenges WHERE id = ?"),
    attGet: db.prepare("SELECT * FROM challenge_attempts WHERE challenge_id = ? AND account_id = ?"),
    attByGame: db.prepare("SELECT * FROM challenge_attempts WHERE game_id = ?"),
    attIns: db.prepare("INSERT INTO challenge_attempts (id, challenge_id, account_id, game_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"),
    attFinish: db.prepare("UPDATE challenge_attempts SET status = ?, official_score = ?, official_max_exponent = ?, finished_at = ? WHERE game_id = ? AND status = 'active'"),
    matchIns: db.prepare("INSERT INTO matches (id, season_id, ruleset_version, kind, seed, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    matchGet: db.prepare("SELECT * FROM matches WHERE id = ?"),
    matchUpd: db.prepare("UPDATE matches SET status = ?, outcome = ?, finalized_at = ?, sequence = sequence + 1 WHERE id = ?"),
    matchBump: db.prepare("UPDATE matches SET sequence = sequence + 1 WHERE id = ?"),
    seatIns: db.prepare("INSERT INTO match_seats (match_id, seat, account_id, bot_config_json, game_id) VALUES (?, ?, ?, ?, ?)"),
    seatsGet: db.prepare("SELECT * FROM match_seats WHERE match_id = ? ORDER BY seat"),
    seatGame: db.prepare("UPDATE match_seats SET game_id = ? WHERE match_id = ? AND seat = ?"),
    seatTerm: db.prepare("UPDATE match_seats SET terminal_reason = ? WHERE match_id = ? AND seat = ? AND terminal_reason IS NULL"),
    seatByGame: db.prepare("SELECT * FROM match_seats WHERE game_id = ?"),
    ratGet: db.prepare("SELECT * FROM ratings WHERE account_id = ? AND season_id = ? AND ruleset_version = ?"),
    ratIns: db.prepare("INSERT OR IGNORE INTO ratings (account_id, season_id, ruleset_version, rating) VALUES (?, ?, ?, ?)"),
    ratUpd: db.prepare(
      `UPDATE ratings SET rating = ?, played = played + 1, won = won + ?, drawn = drawn + ?, lost = lost + ?
       WHERE account_id = ? AND season_id = ? AND ruleset_version = ?`,
    ),
    evIns: db.prepare(
      `INSERT INTO rating_events (match_id, account_id, season_id, ruleset_version, rating_before, rating_after, delta, outcome_x2, idempotency_key, algorithm, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ),
    evByMatch: db.prepare("SELECT * FROM rating_events WHERE match_id = ? ORDER BY id"),
  };

  const ev = (r: Raw): RatingEvent => ({
    matchId: r.match_id as string, accountId: r.account_id as string, seasonId: r.season_id as string, rulesetVersion: r.ruleset_version as string,
    before: r.rating_before as number, after: r.rating_after as number, delta: r.delta as number,
    outcome: ((r.outcome_x2 as number) / 2) as 0 | 0.5 | 1, idempotencyKey: r.idempotency_key as string, algorithm: r.algorithm as "elo-v1",
  });

  return {
    // seasons / challenges
    ensureSeason: (s: SeasonRow) => void q.seasonIns.run(s.id, s.rulesetVersion, s.name, s.startsAt, s.endsAt, s.status),
    season: (id: string) => { const r = q.seasonGet.get(id) as Raw | undefined; return r ? season(r) : undefined; },
    activeSeason: () => { const r = q.seasonActive.get() as Raw | undefined; return r ? season(r) : undefined; },
    /** Make `currentId` the only active season; archive older seasons and close their challenges. */
    rollSeason(currentId: string): void {
      q.seasonActivate.run(currentId);
      q.seasonsClose.run(currentId);
      q.challengesClose.run(currentId);
    },
    ensureChallenge: (c: ChallengeRow) => void q.chIns.run(c.id, c.seasonId, c.rulesetVersion, c.title, c.seed, c.moveCap, c.status, c.createdAt),
    challenge: (id: string) => { const r = q.chGet.get(id) as Raw | undefined; return r ? challenge(r) : undefined; },
    listChallenges(f: { seasonId?: string | undefined; status?: "open" | "closed" | undefined; after?: { createdAt: string; id: string } | undefined; limit: number }): ChallengeRow[] {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.seasonId) { where.push("season_id = ?"); args.push(f.seasonId); }
      if (f.status) { where.push("status = ?"); args.push(f.status); }
      if (f.after) { where.push("(created_at > ? OR (created_at = ? AND id > ?))"); args.push(f.after.createdAt, f.after.createdAt, f.after.id); }
      args.push(f.limit);
      return (db.prepare(`SELECT * FROM challenges ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC LIMIT ?`).all(...args) as Raw[]).map(challenge);
    },
    latestChallenge(seasonId?: string): ChallengeRow | undefined {
      const r = (seasonId
        ? db.prepare("SELECT * FROM challenges WHERE season_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(seasonId)
        : db.prepare("SELECT * FROM challenges ORDER BY created_at DESC, id DESC LIMIT 1").get()) as Raw | undefined;
      return r ? challenge(r) : undefined;
    },

    /** Active attempts whose challenge was closed by a season rollover: abandoning forfeits them. */
    staleAttemptGames: () =>
      (db.prepare("SELECT a.game_id AS gameId FROM challenge_attempts a JOIN challenges c ON c.id = a.challenge_id WHERE a.status = 'active' AND c.status = 'closed'").all() as { gameId: string }[]).map((r) => r.gameId),

    // attempts
    attempt: (challengeId: string, accountId: string) => { const r = q.attGet.get(challengeId, accountId) as Raw | undefined; return r ? attempt(r) : undefined; },
    attemptByGame: (gameId: string) => { const r = q.attByGame.get(gameId) as Raw | undefined; return r ? attempt(r) : undefined; },
    insertAttempt: (a: { id: string; challengeId: string; accountId: string; gameId: string; createdAt: string }) =>
      void q.attIns.run(a.id, a.challengeId, a.accountId, a.gameId, a.createdAt),
    finishAttempt: (gameId: string, status: "completed" | "forfeited", score: string, maxExponent: string, at: string) =>
      q.attFinish.run(status, score, maxExponent, at, gameId).changes > 0,

    // boards
    page: (board: BoardQuery, opts: Parameters<typeof boardPage>[2]) => boardPage(db, board, opts),

    // matches
    insertMatch: (m: { id: string; seasonId: string; rulesetVersion: string; kind: MatchKind; seed: string; status: MatchStatus; createdBy: string | null; createdAt: string }) =>
      void q.matchIns.run(m.id, m.seasonId, m.rulesetVersion, m.kind, m.seed, m.status, m.createdBy, m.createdAt),
    match: (id: string) => { const r = q.matchGet.get(id) as Raw | undefined; return r ? match(r) : undefined; },
    updateMatch: (id: string, status: MatchStatus, outcome: MatchOutcome | null, finalizedAt: string | null) => void q.matchUpd.run(status, outcome, finalizedAt, id),
    bumpMatch: (id: string) => void q.matchBump.run(id),
    insertSeat: (s: { matchId: string; seat: 0 | 1; accountId: string | null; botConfigJson: string | null; gameId: string | null }) =>
      void q.seatIns.run(s.matchId, s.seat, s.accountId, s.botConfigJson, s.gameId),
    seats: (matchId: string) => (q.seatsGet.all(matchId) as Raw[]).map(seatRow),
    seatForGame: (gameId: string) => { const r = q.seatByGame.get(gameId) as Raw | undefined; return r ? seatRow(r) : undefined; },
    setSeatGame: (matchId: string, seat: 0 | 1, gameId: string) => void q.seatGame.run(gameId, matchId, seat),
    setSeatTerminal: (matchId: string, seat: 0 | 1, reason: "move-cap" | "dead" | "forfeit") => void q.seatTerm.run(reason, matchId, seat),
    listMatches(f: { accountId?: string | undefined; status?: MatchStatus | undefined; lobbyOnly?: boolean; after?: { createdAt: string; id: string } | undefined; limit: number }): MatchRow[] {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.lobbyOnly) where.push("m.status = 'lobby'");
      if (f.status) { where.push("m.status = ?"); args.push(f.status); }
      if (f.accountId) {
        where.push("(EXISTS (SELECT 1 FROM match_seats s WHERE s.match_id = m.id AND s.account_id = ?) OR m.created_by = ?)");
        args.push(f.accountId, f.accountId);
      }
      if (f.after) { where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))"); args.push(f.after.createdAt, f.after.createdAt, f.after.id); }
      args.push(f.limit);
      return (db.prepare(`SELECT m.* FROM matches m ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(...args) as Raw[]).map(match);
    },
    /** Matches whose bot seats may need their runs restarted after a crash. */
    activeBotMatches: () => (db.prepare("SELECT * FROM matches WHERE status = 'active' AND kind <> 'human-vs-human'").all() as Raw[]).map(match),

    // ratings
    rating: (accountId: string, seasonId: string, ruleset: string) => { const r = q.ratGet.get(accountId, seasonId, ruleset) as Raw | undefined; return r ? rating(r) : undefined; },
    ensureRating: (accountId: string, seasonId: string, ruleset: string, start: number) => void q.ratIns.run(accountId, seasonId, ruleset, start),
    /** Persist one rating event and update the ladder row; returns the event row id, or 0 when the key already existed. */
    applyRatingEvent(e: RatingEvent, at: string): number {
      const outcomeX2 = Math.round(e.outcome * 2);
      const r = q.evIns.run(e.matchId, e.accountId, e.seasonId, e.rulesetVersion, e.before, e.after, e.delta, outcomeX2, e.idempotencyKey, e.algorithm, at);
      if (r.changes === 0) return 0; // exactly-once: a repeated key changes nothing
      q.ratUpd.run(e.after, e.outcome === 1 ? 1 : 0, e.outcome === 0.5 ? 1 : 0, e.outcome === 0 ? 1 : 0, e.accountId, e.seasonId, e.rulesetVersion);
      return Number(r.lastInsertRowid);
    },
    ratingEvents: (matchId: string) => (q.evByMatch.all(matchId) as Raw[]).map(ev),

    stats(userId: string): ProfileStatsRaw {
      const own = "owner_user_id = ?";
      const gamesPlayed = (db.prepare(`SELECT count(*) AS n FROM games WHERE ${own} AND mode IN ('classic','practice','ranked','duel','bot-exhibition')`).get(userId) as { n: number }).n;
      const bestRow = db.prepare(
        `SELECT id, score FROM games WHERE ${own} AND mode = 'classic' ORDER BY length(score) DESC, score DESC, created_at, id LIMIT 1`,
      ).get(userId) as { id: string; score: string } | undefined;
      const maxRow = db.prepare(
        `SELECT max_exponent FROM games WHERE ${own} AND mode IN ('classic','practice','ranked','duel') ORDER BY length(max_exponent) DESC, max_exponent DESC LIMIT 1`,
      ).get(userId) as { max_exponent: string } | undefined;
      const dist = db.prepare(`SELECT length(score) AS digits, count(*) AS count FROM games WHERE ${own} AND mode = 'classic' GROUP BY length(score) ORDER BY digits`).all(userId) as { digits: number; count: number }[];
      const tiles = db.prepare(
        `SELECT max_exponent AS exponent, count(*) AS count FROM games WHERE ${own} AND mode IN ('classic','practice','ranked','duel') GROUP BY max_exponent ORDER BY length(max_exponent), max_exponent`,
      ).all(userId) as { exponent: string; count: number }[];
      const duel = db.prepare("SELECT COALESCE(sum(won),0) AS won, COALESCE(sum(drawn),0) AS drawn, COALESCE(sum(lost),0) AS lost FROM ratings WHERE account_id = ?").get(userId) as { won: number; drawn: number; lost: number };
      const ranked = db.prepare(
        `SELECT id AS attemptId, challenge_id AS challengeId, game_id AS gameId, official_score AS score, official_max_exponent AS maxExponent
         FROM challenge_attempts WHERE account_id = ? AND status = 'completed' ORDER BY created_at DESC, id DESC LIMIT 50`,
      ).all(userId) as ProfileStatsRaw["rankedAttempts"];
      const bots = db.prepare(
        `SELECT json_extract(r.config_json, '$.strategy') AS strategy, count(*) AS runs,
                (SELECT g.score FROM bot_runs r2 JOIN games g ON g.id = r2.game_id
                  WHERE r2.owner_user_id = r.owner_user_id AND json_extract(r2.config_json, '$.strategy') = json_extract(r.config_json, '$.strategy')
                  ORDER BY length(g.score) DESC, g.score DESC LIMIT 1) AS bestScore
         FROM bot_runs r WHERE r.owner_user_id = ? GROUP BY strategy ORDER BY strategy`,
      ).all(userId) as { strategy: string; runs: number; bestScore: string | null }[];
      return {
        gamesPlayed,
        best: bestRow ? { score: bestRow.score, gameId: bestRow.id } : null,
        maxExponent: maxRow?.max_exponent ?? null,
        scoreDistribution: dist,
        maxTileCounts: tiles,
        duels: duel,
        rankedAttempts: ranked,
        bot: bots,
      };
    },
  };
}

export type CompetitionRepo = ReturnType<typeof competitionRepo>;
