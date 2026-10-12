import type { Database as SqliteDatabase } from "better-sqlite3";

type Raw = Record<string, unknown>;

export type ExportLimits = { maxGames: number; maxMovesPerGame: number };

/** Read-only collection of everything the account owns. Never touches password_hash or sessions. */
export function exportRepo(db: SqliteDatabase) {
  return {
    collect(userId: string, limits: ExportLimits) {
      const account = db.prepare("SELECT id, username_normalized AS username, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ? AND deleted_at IS NULL").get(userId) as Raw | undefined;
      if (!account) return undefined;
      const profile = db.prepare("SELECT preferences, games_played AS gamesPlayed, best_score AS bestScore, best_exponent AS bestExponent FROM profiles WHERE user_id = ?").get(userId) as Raw | undefined;
      const games = db.prepare(
        `SELECT id, mode, ruleset_version AS rulesetVersion, engine_version AS engineVersion, seed, status, score, max_exponent AS maxExponent,
                accepted_moves AS acceptedMoves, revision, challenge_id AS challengeId, match_id AS matchId, seat, created_at AS createdAt, updated_at AS updatedAt
         FROM games WHERE owner_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(userId, limits.maxGames) as Raw[];
      const moveStmt = db.prepare("SELECT revision, kind, direction FROM game_moves WHERE game_id = ? ORDER BY revision LIMIT ?");
      const countStmt = db.prepare("SELECT count(*) AS n FROM game_moves WHERE game_id = ?").pluck();
      for (const g of games) {
        const total = countStmt.get(g.id) as number;
        g.moves = total <= limits.maxMovesPerGame ? moveStmt.all(g.id, limits.maxMovesPerGame) : null;
        g.movesOmitted = total > limits.maxMovesPerGame;
      }
      const attempts = db.prepare(
        `SELECT id, challenge_id AS challengeId, game_id AS gameId, status, official_score AS officialScore, official_max_exponent AS officialMaxExponent,
                created_at AS createdAt, finished_at AS finishedAt FROM challenge_attempts WHERE account_id = ? ORDER BY created_at, id`,
      ).all(userId);
      const ratings = db.prepare("SELECT season_id AS seasonId, ruleset_version AS rulesetVersion, rating, played, won, drawn, lost FROM ratings WHERE account_id = ? ORDER BY season_id").all(userId);
      const ratingEvents = db.prepare(
        `SELECT match_id AS matchId, season_id AS seasonId, ruleset_version AS rulesetVersion, rating_before AS before, rating_after AS after, delta,
                outcome_x2 / 2.0 AS outcome, idempotency_key AS idempotencyKey, algorithm, created_at AS createdAt FROM rating_events WHERE account_id = ? ORDER BY id`,
      ).all(userId);
      const matches = db.prepare(
        `SELECT m.id, m.kind, m.status, m.outcome, m.season_id AS seasonId, m.ruleset_version AS rulesetVersion, m.created_at AS createdAt, m.finalized_at AS finalizedAt,
                s.seat AS mySeat FROM matches m JOIN match_seats s ON s.match_id = m.id WHERE s.account_id = ? ORDER BY m.created_at, m.id`,
      ).all(userId);
      const botRuns = db.prepare(
        `SELECT id, bot_version AS botVersion, mode, config_json AS config, status, game_id AS gameId, moves, created_at AS createdAt
         FROM bot_runs WHERE owner_user_id = ? ORDER BY created_at, id`,
      ).all(userId) as Raw[];
      for (const b of botRuns) b.config = JSON.parse(b.config as string);
      return { account, profile, games, attempts, ratings, ratingEvents, matches, botRuns };
    },
  };
}
export type ExportRepo = ReturnType<typeof exportRepo>;
