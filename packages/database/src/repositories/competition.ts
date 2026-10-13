import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/*
 * Seasons, challenges, official attempts, leaderboards, bot runs, and replay imports.
 * Every ordering of exact values uses canonical decimal TEXT: length first, then BINARY value.
 * Nothing here ever CASTs a score or exponent to a number.
 */

// ---------- seasons & challenges ----------

export type SeasonRow = {
  id: string;
  rulesetVersion: string;
  name: string;
  startsAt: string;
  endsAt: string | null;
  status: string;
};

export type ChallengeRow = {
  id: string;
  seasonId: string;
  rulesetVersion: string;
  seed: string;
  moveCap: number;
  status: "open" | "closed";
  createdAt: string;
};

export type AttemptRow = {
  id: string;
  challengeId: string;
  userId: string;
  gameId: string;
  status: "in-progress" | "completed" | "forfeited";
  officialScore: string | null;
  officialMaxExponent: string | null;
  createdAt: string;
};

type RawAttempt = {
  id: string;
  challenge_id: string;
  user_id: string;
  game_id: string;
  status: AttemptRow["status"];
  official_score: string | null;
  official_max_exponent: string | null;
  created_at: string;
};

function toAttempt(row: RawAttempt | undefined): AttemptRow | null {
  if (!row) return null;
  return {
    id: row.id,
    challengeId: row.challenge_id,
    userId: row.user_id,
    gameId: row.game_id,
    status: row.status,
    officialScore: row.official_score,
    officialMaxExponent: row.official_max_exponent,
    createdAt: row.created_at,
  };
}

const ATTEMPT_COLUMNS =
  "id, challenge_id, user_id, game_id, status, official_score, official_max_exponent, created_at";

export const competitionRepo = {
  /** The active season of a ruleset (one per ruleset: seasons_one_active). */
  activeSeason(db: DatabaseSync, rulesetVersion: string): SeasonRow | null {
    const row = db
      .prepare(
        "SELECT id, ruleset_version, name, starts_at, ends_at, status FROM seasons WHERE status = 'active' AND ruleset_version = ?",
      )
      .get(rulesetVersion) as
      | {
          id: string;
          ruleset_version: string;
          name: string;
          starts_at: string;
          ends_at: string | null;
          status: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          rulesetVersion: row.ruleset_version,
          name: row.name,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          status: row.status,
        }
      : null;
  },

  getSeason(db: DatabaseSync, id: string): SeasonRow | null {
    const row = db
      .prepare("SELECT id, ruleset_version, name, starts_at, ends_at, status FROM seasons WHERE id = ?")
      .get(id) as
      | {
          id: string;
          ruleset_version: string;
          name: string;
          starts_at: string;
          ends_at: string | null;
          status: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          rulesetVersion: row.ruleset_version,
          name: row.name,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          status: row.status,
        }
      : null;
  },

  insertSeason(
    db: DatabaseSync,
    season: { id: string; rulesetVersion: string; name: string; now: string },
  ): void {
    db.prepare(
      "INSERT INTO seasons (id, ruleset_version, name, starts_at, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    ).run(season.id, season.rulesetVersion, season.name, season.now, season.now);
  },

  /** Inserts a catalog challenge if absent; returns true when inserted. Existing rows are never changed. */
  insertChallengeIfMissing(
    db: DatabaseSync,
    challenge: {
      id: string;
      seasonId: string;
      rulesetVersion: string;
      seed: string;
      moveCap: number;
      now: string;
    },
  ): boolean {
    const result = db
      .prepare(
        `INSERT INTO challenges (id, season_id, ruleset_version, seed, move_cap, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?) ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        challenge.id,
        challenge.seasonId,
        challenge.rulesetVersion,
        challenge.seed,
        challenge.moveCap,
        challenge.now,
      );
    return Number(result.changes) === 1;
  },

  getChallenge(db: DatabaseSync, id: string): ChallengeRow | null {
    const row = db
      .prepare(
        "SELECT id, season_id, ruleset_version, seed, move_cap, status, created_at FROM challenges WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          season_id: string;
          ruleset_version: string;
          seed: string;
          move_cap: number;
          status: "open" | "closed";
          created_at: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          seasonId: row.season_id,
          rulesetVersion: row.ruleset_version,
          seed: row.seed,
          moveCap: row.move_cap,
          status: row.status,
          createdAt: row.created_at,
        }
      : null;
  },

  /** Challenges ordered by season start then catalog index (ids `ch-<season>-<n>`, n numeric). */
  listChallenges(db: DatabaseSync): ChallengeRow[] {
    const rows = db
      .prepare(
        `SELECT c.id, c.season_id, c.ruleset_version, c.seed, c.move_cap, c.status, c.created_at
           FROM challenges c JOIN seasons s ON s.id = c.season_id
          ORDER BY s.starts_at DESC, length(c.id), c.id`,
      )
      .all() as {
      id: string;
      season_id: string;
      ruleset_version: string;
      seed: string;
      move_cap: number;
      status: "open" | "closed";
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      seasonId: row.season_id,
      rulesetVersion: row.ruleset_version,
      seed: row.seed,
      moveCap: row.move_cap,
      status: row.status,
      createdAt: row.created_at,
    }));
  },

  attemptFor(db: DatabaseSync, challengeId: string, userId: string): AttemptRow | null {
    return toAttempt(
      db
        .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM challenge_attempts WHERE challenge_id = ? AND user_id = ?`)
        .get(challengeId, userId) as RawAttempt | undefined,
    );
  },

  attemptByGame(db: DatabaseSync, gameId: string): AttemptRow | null {
    return toAttempt(
      db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM challenge_attempts WHERE game_id = ?`).get(gameId) as
        RawAttempt | undefined,
    );
  },

  attemptsForUser(db: DatabaseSync, userId: string): AttemptRow[] {
    return (
      db
        .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM challenge_attempts WHERE user_id = ?`)
        .all(userId) as RawAttempt[]
    )
      .map(toAttempt)
      .filter((a): a is AttemptRow => a !== null);
  },

  insertAttempt(
    db: DatabaseSync,
    attempt: { id: string; challengeId: string; userId: string; gameId: string; now: string },
  ): void {
    db.prepare(
      `INSERT INTO challenge_attempts (id, challenge_id, user_id, game_id, status, created_at)
       VALUES (?, ?, ?, ?, 'in-progress', ?)`,
    ).run(attempt.id, attempt.challengeId, attempt.userId, attempt.gameId, attempt.now);
  },

  finishAttempt(
    db: DatabaseSync,
    attemptId: string,
    result: { status: "completed" | "forfeited"; score: string; maxExponent: string | null; now: string },
  ): boolean {
    const changed = db
      .prepare(
        `UPDATE challenge_attempts SET status = ?, official_score = ?, official_max_exponent = ?, completed_at = ?
          WHERE id = ? AND status = 'in-progress'`,
      )
      .run(result.status, result.score, result.maxExponent, result.now, attemptId);
    return Number(changed.changes) === 1;
  },

  // ---------- leaderboards ----------

  casualBoard(db: DatabaseSync, query: BoardQuery): BoardRow[] {
    const params: SQLInputValue[] = [];
    let window = "";
    if (query.from) {
      window += " AND g.created_at >= ?";
      params.push(query.from);
    }
    if (query.to) {
      window += " AND g.created_at < ?";
      params.push(query.to);
    }
    const base = `
      WITH best AS (
        SELECT g.id AS id, g.id AS game_id, g.owner_user_id AS user_id, g.score AS s,
               COALESCE(g.max_exponent, '') AS e, g.created_at AS c,
               ROW_NUMBER() OVER (PARTITION BY g.owner_user_id ORDER BY ${orderBy("g.score", "COALESCE(g.max_exponent, '')", "g.created_at", "g.id")}) AS rn
          FROM games g
         WHERE g.mode = 'classic' AND g.ruleset_version = 'classic-v1' AND g.owner_user_id IS NOT NULL${window}
      ),
      ranked AS (
        SELECT best.*, ROW_NUMBER() OVER (ORDER BY ${orderBy("s", "e", "c", "id")}) AS rank
          FROM best WHERE rn = 1
      )`;
    return pageQuery(db, base, params, query);
  },

  challengeBoard(
    db: DatabaseSync,
    query: BoardQuery & { challengeId?: string; seasonId?: string; rulesetVersion?: string },
  ): BoardRow[] {
    const params: SQLInputValue[] = [];
    let where = "a.status = 'completed'";
    if (query.challengeId) {
      where += " AND a.challenge_id = ?";
      params.push(query.challengeId);
    }
    if (query.seasonId) {
      where += " AND ch.season_id = ?";
      params.push(query.seasonId);
    }
    if (query.rulesetVersion) {
      where += " AND ch.ruleset_version = ?";
      params.push(query.rulesetVersion);
    }
    const base = `
      WITH ranked AS (
        SELECT a.id AS id, a.game_id AS game_id, a.user_id AS user_id, a.official_score AS s,
               COALESCE(a.official_max_exponent, '') AS e, a.created_at AS c,
               ROW_NUMBER() OVER (ORDER BY ${orderBy("a.official_score", "COALESCE(a.official_max_exponent, '')", "a.created_at", "a.id")}) AS rank
          FROM challenge_attempts a JOIN challenges ch ON ch.id = a.challenge_id
         WHERE ${where}
      )`;
    return pageQuery(db, base, params, query);
  },

  eloBoard(
    db: DatabaseSync,
    query: {
      seasonId: string;
      rulesetVersion: string;
      after: { rating: number; userId: string; rank: number } | null;
      account?: string;
      limit: number;
    },
  ): EloRow[] {
    const params: SQLInputValue[] = [query.seasonId, query.rulesetVersion];
    let filter = "";
    if (query.after) {
      filter += " AND (rating < ? OR (rating = ? AND user_id > ?))";
      params.push(query.after.rating, query.after.rating, query.after.userId);
    }
    if (query.account) {
      filter += " AND user_id = ?";
      params.push(query.account);
    }
    params.push(query.limit);
    return db
      .prepare(
        `WITH ranked AS (
           SELECT r.user_id, r.rating, r.played, r.updated_at,
                  ROW_NUMBER() OVER (ORDER BY r.rating DESC, r.user_id ASC) AS rank
             FROM ratings r WHERE r.season_id = ? AND r.ruleset_version = ?
         )
         SELECT ranked.user_id AS userId, ranked.rating, ranked.played, ranked.updated_at AS updatedAt, ranked.rank,
                u.display_name AS displayName, u.deleted_at AS deletedAt
           FROM ranked JOIN users u ON u.id = ranked.user_id
          WHERE 1 = 1${filter}
          ORDER BY ranked.rating DESC, ranked.user_id ASC LIMIT ?`,
      )
      .all(...params) as EloRow[];
  },

  /** Finished bot-vs-bot matches with both seats' results (input for computeBotLeague). */
  botLeagueSeats(db: DatabaseSync, filter: { seasonId?: string; rulesetVersion?: string }): BotSeatRow[] {
    const params: SQLInputValue[] = [];
    let where = "m.kind = 'bot-bot' AND m.status = 'finished'";
    if (filter.seasonId) {
      where += " AND m.season_id = ?";
      params.push(filter.seasonId);
    }
    if (filter.rulesetVersion) {
      where += " AND m.ruleset_version = ?";
      params.push(filter.rulesetVersion);
    }
    return db
      .prepare(
        `SELECT m.id AS matchId, m.outcome, m.finalized_at AS finalizedAt, s.seat, s.bot_strategy AS strategy,
                s.bot_version AS botVersion, s.bot_config_json AS configJson, g.score, g.max_exponent AS maxExponent
           FROM matches m JOIN match_seats s ON s.match_id = m.id JOIN games g ON g.id = s.game_id
          WHERE ${where} ORDER BY m.finalized_at, m.id, s.seat`,
      )
      .all(...params) as BotSeatRow[];
  },

  // ---------- bot runs ----------

  insertBotRun(
    db: DatabaseSync,
    run: {
      id: string;
      ownerUserId: string | null;
      ownerGuestId: string | null;
      strategy: string;
      botVersion: string;
      configJson: string;
      nodeBudget: number;
      timeBudgetMs: number;
      seed: string;
      status: string;
      now: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO bot_runs (id, owner_user_id, owner_guest_id, strategy, bot_version, config_json, node_budget,
         time_budget_ms, seed, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.ownerUserId,
      run.ownerGuestId,
      run.strategy,
      run.botVersion,
      run.configJson,
      run.nodeBudget,
      run.timeBudgetMs,
      run.seed,
      run.status,
      run.now,
      run.now,
    );
  },

  updateBotRun(
    db: DatabaseSync,
    id: string,
    update: { status: string; movesPlayed: number; metricsJson: string; gameId?: string | null; now: string },
  ): void {
    db.prepare(
      `UPDATE bot_runs SET status = ?, moves_played = ?, metrics_json = ?, game_id = COALESCE(?, game_id), updated_at = ?
        WHERE id = ?`,
    ).run(update.status, update.movesPlayed, update.metricsJson, update.gameId ?? null, update.now, id);
  },

  getBotRun(db: DatabaseSync, id: string): BotRunRow | null {
    const row = db
      .prepare(
        `SELECT id, owner_user_id AS ownerUserId, owner_guest_id AS ownerGuestId, strategy, bot_version AS botVersion,
                config_json AS configJson, node_budget AS nodeBudget, time_budget_ms AS timeBudgetMs, seed, game_id AS gameId,
                status, moves_played AS movesPlayed, metrics_json AS metricsJson
           FROM bot_runs WHERE id = ?`,
      )
      .get(id) as BotRunRow | undefined;
    return row ?? null;
  },

  /** Restart recovery: runs that were in flight are cancelled (never counted as finished results). */
  cancelInterruptedBotRuns(db: DatabaseSync, now: string): number {
    const result = db
      .prepare(
        `UPDATE bot_runs SET status = 'cancelled', updated_at = ?,
            metrics_json = json_set(metrics_json, '$.interruptedByRestart', json('true'))
          WHERE status IN ('queued', 'running', 'paused')`,
      )
      .run(now);
    return Number(result.changes);
  },

  // ---------- replay imports ----------

  insertReplayImport(
    db: DatabaseSync,
    replay: {
      id: string;
      ownerUserId: string | null;
      ownerGuestId: string | null;
      replaySchemaVersion: number;
      engineVersion: string;
      rulesetVersion: string;
      finalChecksum: string;
      moves: number;
      sizeBytes: number;
      replayJson: string;
      now: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO replay_imports (id, owner_user_id, owner_guest_id, replay_schema_version, engine_version, ruleset_version,
         final_checksum, moves, size_bytes, replay_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      replay.id,
      replay.ownerUserId,
      replay.ownerGuestId,
      replay.replaySchemaVersion,
      replay.engineVersion,
      replay.rulesetVersion,
      replay.finalChecksum,
      replay.moves,
      replay.sizeBytes,
      replay.replayJson,
      replay.now,
    );
  },

  getReplayImport(
    db: DatabaseSync,
    id: string,
  ): { id: string; ownerUserId: string | null; ownerGuestId: string | null; replayJson: string } | null {
    const row = db
      .prepare(
        "SELECT id, owner_user_id AS ownerUserId, owner_guest_id AS ownerGuestId, replay_json AS replayJson FROM replay_imports WHERE id = ?",
      )
      .get(id) as
      { id: string; ownerUserId: string | null; ownerGuestId: string | null; replayJson: string } | undefined;
    return row ?? null;
  },
};

export type BotRunRow = {
  id: string;
  ownerUserId: string | null;
  ownerGuestId: string | null;
  strategy: string;
  botVersion: string;
  configJson: string;
  nodeBudget: number;
  timeBudgetMs: number;
  seed: string;
  gameId: string | null;
  status: string;
  movesPlayed: number;
  metricsJson: string;
};

export type BotSeatRow = {
  matchId: string;
  outcome: "seat-a" | "seat-b" | "draw";
  finalizedAt: string;
  seat: "a" | "b";
  strategy: string;
  botVersion: string;
  configJson: string;
  score: string;
  maxExponent: string | null;
};

export type EloRow = {
  userId: string;
  rating: number;
  played: number;
  updatedAt: string;
  rank: number;
  displayName: string;
  deletedAt: string | null;
};

/** Keyset position in the total order: score (s), max exponent (e, '' for none), created (c), id (i). */
export type BoardKey = { s: string; e: string; c: string; i: string; rank: number };
export type BoardQuery = {
  after: BoardKey | null;
  account?: string;
  limit: number;
  from?: string;
  to?: string;
};
export type BoardRow = {
  id: string;
  gameId: string;
  userId: string;
  score: string;
  maxExponent: string;
  createdAt: string;
  rank: number;
  displayName: string;
  deletedAt: string | null;
};

/** LEADERBOARD_ORDER over the given SQL expressions: score, max exponent ('' = none), created, id. */
function orderBy(s: string, e: string, c: string, i: string): string {
  return `length(${s}) DESC, ${s} DESC, length(${e}) DESC, ${e} DESC, ${c} ASC, ${i} ASC`;
}

/** Rows of `ranked` strictly after the key in the total order (decimal: length, then value). */
const AFTER = `(length(ranked.s) < length(?) OR (length(ranked.s) = length(?) AND ranked.s < ?)
   OR (ranked.s = ? AND (length(ranked.e) < length(?) OR (length(ranked.e) = length(?) AND ranked.e < ?)
   OR (ranked.e = ? AND (ranked.c > ? OR (ranked.c = ? AND ranked.id > ?))))))`;

function pageQuery(db: DatabaseSync, base: string, params: SQLInputValue[], query: BoardQuery): BoardRow[] {
  const all = [...params];
  let filter = "";
  if (query.after) {
    const k = query.after;
    filter += ` AND ${AFTER}`;
    all.push(k.s, k.s, k.s, k.s, k.e, k.e, k.e, k.e, k.c, k.c, k.i);
  }
  if (query.account) {
    filter += " AND ranked.user_id = ?";
    all.push(query.account);
  }
  all.push(query.limit);
  return db
    .prepare(
      `${base}
       SELECT ranked.id AS id, ranked.game_id AS gameId, ranked.user_id AS userId, ranked.s AS score, ranked.e AS maxExponent,
              ranked.c AS createdAt, ranked.rank AS rank, u.display_name AS displayName, u.deleted_at AS deletedAt
         FROM ranked JOIN users u ON u.id = ranked.user_id
        WHERE 1 = 1${filter}
        ORDER BY ${orderBy("ranked.s", "ranked.e", "ranked.c", "ranked.id")}
        LIMIT ?`,
    )
    .all(...all) as BoardRow[];
}
