import type { DatabaseSync } from "node:sqlite";
import type { BotConfig, BotStrategy, DuelOutcome, MatchKind, MatchStatus, SeatId } from "@g2048/contracts";
import type { SeatTerminalReason } from "@g2048/contracts";

/** SQL for matches, match_seats, ratings, rating_events and match_events (seasons: competitionRepo). */

export type MatchRow = {
  id: string;
  kind: MatchKind;
  seasonId: string | null;
  rulesetVersion: string;
  seed: string;
  status: MatchStatus;
  outcome: DuelOutcome | null;
  sequence: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
};

export type SeatRow = {
  matchId: string;
  seat: SeatId;
  userId: string | null;
  botStrategy: BotStrategy | null;
  botVersion: string | null;
  botConfig: BotConfig | null;
  gameId: string | null;
  terminalReason: SeatTerminalReason | null;
  joinedAt: string;
  endedAt: string | null;
};

export type RatingRow = {
  userId: string;
  seasonId: string;
  rulesetVersion: string;
  rating: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
};

export type StoredRatingEvent = {
  matchId: string;
  userId: string;
  seasonId: string;
  rulesetVersion: string;
  before: number;
  after: number;
  delta: number;
  outcome: "1" | "0.5" | "0";
  algorithm: string;
  idempotencyKey: string;
  createdAt: string;
};

export type StoredMatchEvent = { sequence: number; type: string; payload: unknown };

type RawMatch = {
  id: string;
  kind: MatchKind;
  season_id: string | null;
  ruleset_version: string;
  seed: string;
  status: MatchStatus;
  outcome: DuelOutcome | null;
  sequence: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
};

type RawSeat = {
  match_id: string;
  seat: SeatId;
  user_id: string | null;
  bot_strategy: BotStrategy | null;
  bot_version: string | null;
  bot_config_json: string | null;
  game_id: string | null;
  terminal_reason: SeatTerminalReason | null;
  joined_at: string;
  ended_at: string | null;
};

const MATCH_COLUMNS =
  "id, kind, season_id, ruleset_version, seed, status, outcome, sequence, created_by_user_id, created_at, updated_at, finalized_at";
const SEAT_COLUMNS =
  "match_id, seat, user_id, bot_strategy, bot_version, bot_config_json, game_id, terminal_reason, joined_at, ended_at";

function toMatch(r: RawMatch): MatchRow {
  return {
    id: r.id,
    kind: r.kind,
    seasonId: r.season_id,
    rulesetVersion: r.ruleset_version,
    seed: r.seed,
    status: r.status,
    outcome: r.outcome,
    sequence: r.sequence,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finalizedAt: r.finalized_at,
  };
}

function toSeat(r: RawSeat): SeatRow {
  return {
    matchId: r.match_id,
    seat: r.seat,
    userId: r.user_id,
    botStrategy: r.bot_strategy,
    botVersion: r.bot_version,
    botConfig: r.bot_config_json === null ? null : (JSON.parse(r.bot_config_json) as BotConfig),
    gameId: r.game_id,
    terminalReason: r.terminal_reason,
    joinedAt: r.joined_at,
    endedAt: r.ended_at,
  };
}

export const matchesRepo = {
  insertMatch(db: DatabaseSync, m: Omit<MatchRow, "outcome" | "finalizedAt" | "updatedAt">): void {
    db.prepare(
      `INSERT INTO matches (id, kind, season_id, ruleset_version, seed, status, outcome, sequence, created_by_user_id,
         created_at, updated_at, finalized_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    ).run(
      m.id,
      m.kind,
      m.seasonId,
      m.rulesetVersion,
      m.seed,
      m.status,
      m.sequence,
      m.createdByUserId,
      m.createdAt,
      m.createdAt,
    );
  },

  get(db: DatabaseSync, id: string): MatchRow | null {
    const row = db.prepare(`SELECT ${MATCH_COLUMNS} FROM matches WHERE id = ?`).get(id) as
      RawMatch | undefined;
    return row ? toMatch(row) : null;
  },

  setStatus(
    db: DatabaseSync,
    id: string,
    status: MatchStatus,
    outcome: DuelOutcome | null,
    now: string,
  ): void {
    db.prepare(
      `UPDATE matches SET status = ?, outcome = ?, updated_at = ?,
         finalized_at = CASE WHEN ? = 'finished' THEN COALESCE(finalized_at, ?) ELSE NULL END
       WHERE id = ?`,
    ).run(status, outcome, now, status, now, id);
  },

  /** Allocates the next per-match WebSocket sequence (inside the writer transaction). */
  bumpSequence(db: DatabaseSync, id: string, now: string): number {
    db.prepare("UPDATE matches SET sequence = sequence + 1, updated_at = ? WHERE id = ?").run(now, id);
    const row = db.prepare("SELECT sequence FROM matches WHERE id = ?").get(id) as
      { sequence: number } | undefined;
    if (!row) throw new Error(`match ${id} vanished`);
    return Number(row.sequence);
  },

  seats(db: DatabaseSync, matchId: string): SeatRow[] {
    return (
      db
        .prepare(`SELECT ${SEAT_COLUMNS} FROM match_seats WHERE match_id = ? ORDER BY seat`)
        .all(matchId) as RawSeat[]
    ).map(toSeat);
  },

  insertSeat(
    db: DatabaseSync,
    s: {
      matchId: string;
      seat: SeatId;
      userId: string | null;
      bot: { strategy: BotStrategy; version: string; config: BotConfig } | null;
      gameId: string | null;
      now: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO match_seats (match_id, seat, user_id, bot_strategy, bot_version, bot_config_json, game_id,
         terminal_reason, joined_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    ).run(
      s.matchId,
      s.seat,
      s.userId,
      s.bot?.strategy ?? null,
      s.bot?.version ?? null,
      s.bot ? JSON.stringify(s.bot.config) : null,
      s.gameId,
      s.now,
    );
  },

  setSeatGame(db: DatabaseSync, matchId: string, seat: SeatId, gameId: string): void {
    db.prepare("UPDATE match_seats SET game_id = ? WHERE match_id = ? AND seat = ? AND game_id IS NULL").run(
      gameId,
      matchId,
      seat,
    );
  },

  /** Marks a seat terminal exactly once; false if it already was. */
  endSeat(db: DatabaseSync, matchId: string, seat: SeatId, reason: SeatTerminalReason, now: string): boolean {
    const result = db
      .prepare(
        `UPDATE match_seats SET terminal_reason = ?, ended_at = ?
         WHERE match_id = ? AND seat = ? AND terminal_reason IS NULL`,
      )
      .run(reason, now, matchId, seat);
    return Number(result.changes) === 1;
  },

  findSeatByGame(db: DatabaseSync, gameId: string): { matchId: string; seat: SeatId } | null {
    const row = db.prepare("SELECT match_id, seat FROM match_seats WHERE game_id = ?").get(gameId) as
      { match_id: string; seat: SeatId } | undefined;
    return row ? { matchId: row.match_id, seat: row.seat } : null;
  },

  /** Matches a user plays in or created (newest first), plus open human-human lobbies of others. */
  listVisible(db: DatabaseSync, userId: string, limit: number): MatchRow[] {
    return (
      db
        .prepare(
          `SELECT ${MATCH_COLUMNS} FROM matches m
           WHERE m.status IN ('lobby', 'active') AND (
             m.created_by_user_id = $user
             OR EXISTS (SELECT 1 FROM match_seats s WHERE s.match_id = m.id AND s.user_id = $user)
             OR (m.status = 'lobby' AND m.kind = 'human-human'))
           ORDER BY m.created_at DESC, m.id DESC LIMIT $limit`,
        )
        .all({ user: userId, limit }) as RawMatch[]
    ).map(toMatch);
  },

  activeIds(db: DatabaseSync): string[] {
    return (
      db.prepare("SELECT id FROM matches WHERE status = 'active' ORDER BY created_at, id").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
  },

  // ---------- ratings ----------

  rating(db: DatabaseSync, userId: string, seasonId: string, rulesetVersion: string): RatingRow | null {
    const row = db
      .prepare(
        `SELECT user_id, season_id, ruleset_version, rating, played, won, drawn, lost FROM ratings
         WHERE user_id = ? AND season_id = ? AND ruleset_version = ?`,
      )
      .get(userId, seasonId, rulesetVersion) as
      | {
          user_id: string;
          season_id: string;
          ruleset_version: string;
          rating: number;
          played: number;
          won: number;
          drawn: number;
          lost: number;
        }
      | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      seasonId: row.season_id,
      rulesetVersion: row.ruleset_version,
      rating: Number(row.rating),
      played: Number(row.played),
      won: Number(row.won),
      drawn: Number(row.drawn),
      lost: Number(row.lost),
    };
  },

  upsertRating(db: DatabaseSync, r: RatingRow, now: string): void {
    db.prepare(
      `INSERT INTO ratings (user_id, season_id, ruleset_version, rating, played, won, drawn, lost, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, season_id, ruleset_version) DO UPDATE SET
         rating = excluded.rating, played = excluded.played, won = excluded.won, drawn = excluded.drawn,
         lost = excluded.lost, updated_at = excluded.updated_at`,
    ).run(r.userId, r.seasonId, r.rulesetVersion, r.rating, r.played, r.won, r.drawn, r.lost, now);
  },

  /** Inserts a rating event; the UNIQUE (match_id, user_id) key makes a second insert fail the tx. */
  insertRatingEvent(db: DatabaseSync, e: StoredRatingEvent): void {
    db.prepare(
      `INSERT INTO rating_events (match_id, user_id, season_id, ruleset_version, rating_before, rating_after, delta,
         outcome, algorithm, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.matchId,
      e.userId,
      e.seasonId,
      e.rulesetVersion,
      e.before,
      e.after,
      e.delta,
      e.outcome,
      e.algorithm,
      e.idempotencyKey,
      e.createdAt,
    );
  },

  ratingEvents(db: DatabaseSync, matchId: string): StoredRatingEvent[] {
    const rows = db
      .prepare(
        `SELECT match_id, user_id, season_id, ruleset_version, rating_before, rating_after, delta, outcome, algorithm,
           idempotency_key, created_at FROM rating_events WHERE match_id = ? ORDER BY id`,
      )
      .all(matchId) as {
      match_id: string;
      user_id: string;
      season_id: string;
      ruleset_version: string;
      rating_before: number;
      rating_after: number;
      delta: number;
      outcome: "1" | "0.5" | "0";
      algorithm: string;
      idempotency_key: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      matchId: r.match_id,
      userId: r.user_id,
      seasonId: r.season_id,
      rulesetVersion: r.ruleset_version,
      before: Number(r.rating_before),
      after: Number(r.rating_after),
      delta: Number(r.delta),
      outcome: r.outcome,
      algorithm: r.algorithm,
      idempotencyKey: r.idempotency_key,
      createdAt: r.created_at,
    }));
  },

  displayName(db: DatabaseSync, userId: string): string {
    const row = db.prepare("SELECT display_name, deleted_at FROM users WHERE id = ?").get(userId) as
      { display_name: string; deleted_at: string | null } | undefined;
    if (!row || row.deleted_at !== null) return "Deleted player";
    return row.display_name;
  },

  // ---------- match event log (migration 4) ----------

  insertMatchEvent(
    db: DatabaseSync,
    e: { matchId: string; sequence: number; type: string; payload: unknown; now: string },
  ): void {
    db.prepare(
      "INSERT INTO match_events (match_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(e.matchId, e.sequence, e.type, JSON.stringify(e.payload), e.now);
  },

  matchEventsAfter(
    db: DatabaseSync,
    matchId: string,
    afterSequence: number,
    limit: number,
  ): StoredMatchEvent[] {
    return (
      db
        .prepare(
          `SELECT sequence, type, payload_json FROM match_events WHERE match_id = ? AND sequence > ?
           ORDER BY sequence LIMIT ?`,
        )
        .all(matchId, afterSequence, limit) as { sequence: number; type: string; payload_json: string }[]
    ).map((r) => ({
      sequence: Number(r.sequence),
      type: r.type,
      payload: JSON.parse(r.payload_json) as unknown,
    }));
  },
};
