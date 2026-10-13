import type { DatabaseSync } from "node:sqlite";
import {
  SCHEMA_VERSION,
  type Board,
  type GameMode,
  type GameState,
  type RandomState,
} from "@g2048/contracts";

/**
 * Persistence for authoritative games: the `games` row holds the current state (board/PRNG/score
 * columns), `game_commands` the idempotency log (incl. no-ops), `game_moves` one record per accepted
 * command (move / undo / forfeit) with its post-state checksum, and `game_snapshots` periodic full
 * states. All writers run inside the caller's single-writer transaction.
 */
export type GameOwnerRef = { userId: string } | { guestId: string };

export type GameRecord = {
  id: string;
  ownerUserId: string | null;
  ownerGuestId: string | null;
  mode: GameMode;
  rulesetVersion: string;
  rulesJson: string;
  seed: string;
  state: GameState;
  stateChecksum: string;
  maxExponent: string | null;
  /** Size of the bounded undo stack (migration 2). */
  undoAvailable: number;
  createdAt: string;
  updatedAt: string;
};

type RawGame = {
  id: string;
  owner_user_id: string | null;
  owner_guest_id: string | null;
  mode: GameMode;
  ruleset_version: string;
  rules_json: string;
  engine_version: string;
  seed: string;
  board_json: string;
  rng_state: string;
  score: string;
  max_exponent: string | null;
  accepted_moves: number;
  revision: number;
  status: GameState["status"];
  celebrated_2048: number;
  state_checksum: string;
  undo_available: number;
  created_at: string;
  updated_at: string;
};

const GAME_COLUMNS = `id, owner_user_id, owner_guest_id, mode, ruleset_version, rules_json, engine_version, seed,
  board_json, rng_state, score, max_exponent, accepted_moves, revision, status, celebrated_2048, state_checksum,
  undo_available, created_at, updated_at`;

function toRecord(row: RawGame): GameRecord {
  const board = JSON.parse(row.board_json) as Board;
  const rng = JSON.parse(row.rng_state) as RandomState;
  const state: GameState = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: row.engine_version,
    rulesetVersion: row.ruleset_version,
    board: { size: board.size, cells: board.cells },
    score: row.score,
    acceptedMoves: row.accepted_moves,
    revision: row.revision,
    rng: { algorithm: rng.algorithm, words: rng.words },
    status: row.status,
    celebrated2048: row.celebrated_2048 === 1,
  };
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerGuestId: row.owner_guest_id,
    mode: row.mode,
    rulesetVersion: row.ruleset_version,
    rulesJson: row.rules_json,
    seed: row.seed,
    state,
    stateChecksum: row.state_checksum,
    maxExponent: row.max_exponent,
    undoAvailable: row.undo_available,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boardJson(state: GameState): string {
  return JSON.stringify({ size: state.board.size, cells: state.board.cells });
}

function rngJson(state: GameState): string {
  return JSON.stringify({ algorithm: state.rng.algorithm, words: state.rng.words });
}

export type MoveLogRow = {
  revision: number;
  commandId: string;
  kind: "move" | "undo" | "forfeit";
  direction: "up" | "right" | "down" | "left" | null;
  eventsJson: string;
  checksum: string;
  undone: boolean;
};

type RawMove = {
  revision: number;
  command_id: string;
  kind: MoveLogRow["kind"];
  direction: MoveLogRow["direction"];
  events_json: string;
  checksum: string;
  undone: number;
};

function toMove(row: RawMove): MoveLogRow {
  return {
    revision: row.revision,
    commandId: row.command_id,
    kind: row.kind,
    direction: row.direction,
    eventsJson: row.events_json,
    checksum: row.checksum,
    undone: row.undone === 1,
  };
}

const MOVE_COLUMNS = "revision, command_id, kind, direction, events_json, checksum, undone";

export const gamesRepo = {
  insert(
    db: DatabaseSync,
    game: {
      id: string;
      /** null for games no human or guest owns (e.g. bot-vs-bot seats). */
      owner: GameOwnerRef | null;
      mode: GameMode;
      rulesJson: string;
      seed: string;
      state: GameState;
      checksum: string;
      maxExponent: string | null;
      now: string;
    },
  ): void {
    const s = game.state;
    db.prepare(
      `INSERT INTO games (id, owner_user_id, owner_guest_id, mode, ruleset_version, rules_json, engine_version, seed,
         board_size, board_json, rng_state, score, max_exponent, accepted_moves, revision, status, celebrated_2048,
         state_checksum, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      game.id,
      game.owner && "userId" in game.owner ? game.owner.userId : null,
      game.owner && "guestId" in game.owner ? game.owner.guestId : null,
      game.mode,
      s.rulesetVersion,
      game.rulesJson,
      s.engineVersion,
      game.seed,
      s.board.size,
      boardJson(s),
      rngJson(s),
      s.score,
      game.maxExponent,
      s.acceptedMoves,
      s.revision,
      s.status,
      s.celebrated2048 ? 1 : 0,
      game.checksum,
      game.now,
      game.now,
      s.status === "active" ? null : game.now,
    );
  },

  get(db: DatabaseSync, id: string): GameRecord | null {
    const row = db.prepare(`SELECT ${GAME_COLUMNS} FROM games WHERE id = ?`).get(id) as RawGame | undefined;
    return row ? toRecord(row) : null;
  },

  /**
   * Writes a new current state. Guarded by the expected previous revision so a lost race can never
   * overwrite a newer state (returns false; the caller aborts its transaction).
   */
  updateState(
    db: DatabaseSync,
    id: string,
    previousRevision: number,
    state: GameState,
    checksum: string,
    maxExponent: string | null,
    now: string,
    undoAvailable = 0,
  ): boolean {
    const result = db
      .prepare(
        `UPDATE games SET board_json = ?, rng_state = ?, score = ?, max_exponent = ?, accepted_moves = ?, revision = ?,
           status = ?, celebrated_2048 = ?, state_checksum = ?, updated_at = ?, undo_available = ?,
           finished_at = CASE WHEN ? = 'active' THEN NULL ELSE COALESCE(finished_at, ?) END
         WHERE id = ? AND revision = ?`,
      )
      .run(
        boardJson(state),
        rngJson(state),
        state.score,
        maxExponent,
        state.acceptedMoves,
        state.revision,
        state.status,
        state.celebrated2048 ? 1 : 0,
        checksum,
        now,
        undoAvailable,
        state.status,
        now,
        id,
        previousRevision,
      );
    return Number(result.changes) === 1;
  },

  /** Owned games with `status` and one of `modes`, newest activity first; keyset cursor on (updated_at, id). */
  listOwned(
    db: DatabaseSync,
    owner: GameOwnerRef,
    status: GameState["status"],
    modes: readonly GameMode[],
    after: { updatedAt: string; id: string } | null,
    limit: number,
  ): GameRecord[] {
    const column = "userId" in owner ? "owner_user_id" : "owner_guest_id";
    const ownerId = "userId" in owner ? owner.userId : owner.guestId;
    const modeList = modes.map(() => "?").join(", ");
    const rows = after
      ? db
          .prepare(
            `SELECT ${GAME_COLUMNS} FROM games WHERE ${column} = ? AND status = ? AND mode IN (${modeList})
               AND (updated_at < ? OR (updated_at = ? AND id < ?))
             ORDER BY updated_at DESC, id DESC LIMIT ?`,
          )
          .all(ownerId, status, ...modes, after.updatedAt, after.updatedAt, after.id, limit)
      : db
          .prepare(
            `SELECT ${GAME_COLUMNS} FROM games WHERE ${column} = ? AND status = ? AND mode IN (${modeList})
             ORDER BY updated_at DESC, id DESC LIMIT ?`,
          )
          .all(ownerId, status, ...modes, limit);
    return (rows as RawGame[]).map(toRecord);
  },

  countActiveOwned(db: DatabaseSync, owner: GameOwnerRef, modes: readonly GameMode[]): number {
    const column = "userId" in owner ? "owner_user_id" : "owner_guest_id";
    const ownerId = "userId" in owner ? owner.userId : owner.guestId;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM games WHERE ${column} = ? AND status = 'active'
           AND mode IN (${modes.map(() => "?").join(", ")})`,
      )
      .get(ownerId, ...modes) as { n: number };
    return row.n;
  },

  /** Keeps only the newest `keep` no-change command rows of a game (bounded idempotency log for no-ops). */
  pruneNoChangeCommands(db: DatabaseSync, gameId: string, keep: number): number {
    const result = db
      .prepare(
        `DELETE FROM game_commands WHERE game_id = ? AND outcome = 'no-change' AND rowid NOT IN (
           SELECT rowid FROM game_commands WHERE game_id = ? AND outcome = 'no-change' ORDER BY rowid DESC LIMIT ?)`,
      )
      .run(gameId, gameId, keep);
    return Number(result.changes);
  },

  listIdsByStatus(db: DatabaseSync, status: GameState["status"]): string[] {
    return (
      db.prepare("SELECT id FROM games WHERE status = ? ORDER BY id").all(status) as { id: string }[]
    ).map((r) => r.id);
  },

  // ---------- idempotency log ----------

  findCommand(
    db: DatabaseSync,
    gameId: string,
    commandId: string,
  ): { kind: string; payloadHash: string; responseJson: string } | null {
    const row = db
      .prepare(
        "SELECT kind, payload_hash, response_json FROM game_commands WHERE game_id = ? AND command_id = ?",
      )
      .get(gameId, commandId) as { kind: string; payload_hash: string; response_json: string } | undefined;
    return row ? { kind: row.kind, payloadHash: row.payload_hash, responseJson: row.response_json } : null;
  },

  insertCommand(
    db: DatabaseSync,
    command: {
      gameId: string;
      commandId: string;
      kind: "move" | "undo" | "forfeit";
      payloadHash: string;
      outcome: "applied" | "no-change";
      revisionBefore: number;
      revisionAfter: number;
      responseJson: string;
      now: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO game_commands (game_id, command_id, kind, payload_hash, outcome, revision_before, revision_after,
         response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      command.gameId,
      command.commandId,
      command.kind,
      command.payloadHash,
      command.outcome,
      command.revisionBefore,
      command.revisionAfter,
      command.responseJson,
      command.now,
    );
  },

  setCommandResponse(db: DatabaseSync, gameId: string, commandId: string, responseJson: string): void {
    db.prepare("UPDATE game_commands SET response_json = ? WHERE game_id = ? AND command_id = ?").run(
      responseJson,
      gameId,
      commandId,
    );
  },

  // ---------- accepted command log ----------

  insertMove(
    db: DatabaseSync,
    move: {
      gameId: string;
      revision: number;
      commandId: string;
      kind: "move" | "undo" | "forfeit";
      direction: MoveLogRow["direction"];
      scoreDelta: string;
      eventsJson: string;
      checksum: string;
      now: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO game_moves (game_id, revision, command_id, kind, direction, score_delta, events_json, checksum,
         created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      move.gameId,
      move.revision,
      move.commandId,
      move.kind,
      move.direction,
      move.scoreDelta,
      move.eventsJson,
      move.checksum,
      move.now,
    );
  },

  /** Audit/branch marker: the move stays in the log but is excluded from the replayable final path. */
  markUndone(db: DatabaseSync, gameId: string, revision: number): boolean {
    const result = db
      .prepare(
        "UPDATE game_moves SET undone = 1 WHERE game_id = ? AND revision = ? AND kind = 'move' AND undone = 0",
      )
      .run(gameId, revision);
    return Number(result.changes) === 1;
  },

  lastActiveMove(db: DatabaseSync, gameId: string): MoveLogRow | null {
    const row = db
      .prepare(
        `SELECT ${MOVE_COLUMNS} FROM game_moves WHERE game_id = ? AND kind = 'move' AND undone = 0
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(gameId) as RawMove | undefined;
    return row ? toMove(row) : null;
  },

  /** Number of consecutive `undo` records at the end of the log (bounded by `limit`). */
  trailingUndoCount(db: DatabaseSync, gameId: string, limit: number): number {
    const kinds = db
      .prepare("SELECT kind FROM game_moves WHERE game_id = ? ORDER BY revision DESC LIMIT ?")
      .all(gameId, limit) as { kind: string }[];
    let count = 0;
    for (const { kind } of kinds) {
      if (kind !== "undo") break;
      count += 1;
    }
    return count;
  },

  /** Log records with afterRevision < revision <= uptoRevision, ascending. */
  movesBetween(db: DatabaseSync, gameId: string, afterRevision: number, uptoRevision: number): MoveLogRow[] {
    return (
      db
        .prepare(
          `SELECT ${MOVE_COLUMNS} FROM game_moves WHERE game_id = ? AND revision > ? AND revision <= ?
           ORDER BY revision ASC`,
        )
        .all(gameId, afterRevision, uptoRevision) as RawMove[]
    ).map(toMove);
  },

  eventsPage(db: DatabaseSync, gameId: string, afterRevision: number, limit: number): MoveLogRow[] {
    return (
      db
        .prepare(
          `SELECT ${MOVE_COLUMNS} FROM game_moves WHERE game_id = ? AND revision > ? ORDER BY revision ASC LIMIT ?`,
        )
        .all(gameId, afterRevision, limit) as RawMove[]
    ).map(toMove);
  },

  // ---------- snapshots ----------

  insertSnapshot(
    db: DatabaseSync,
    snapshot: {
      gameId: string;
      revision: number;
      stateJson: string;
      score: string;
      checksum: string;
      now: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO game_snapshots (game_id, revision, state_json, score, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshot.gameId,
      snapshot.revision,
      snapshot.stateJson,
      snapshot.score,
      snapshot.checksum,
      snapshot.now,
    );
  },

  latestSnapshotAtOrBefore(
    db: DatabaseSync,
    gameId: string,
    revision: number,
  ): { revision: number; stateJson: string; checksum: string } | null {
    const row = db
      .prepare(
        `SELECT revision, state_json, checksum FROM game_snapshots WHERE game_id = ? AND revision <= ?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(gameId, revision) as { revision: number; state_json: string; checksum: string } | undefined;
    return row ? { revision: row.revision, stateJson: row.state_json, checksum: row.checksum } : null;
  },

  // ---------- profile statistics (same transaction as the move) ----------

  bumpProfileGamesStarted(db: DatabaseSync, userId: string, now: string): void {
    db.prepare("UPDATE profiles SET games_started = games_started + 1, updated_at = ? WHERE user_id = ?").run(
      now,
      userId,
    );
  },

  /**
   * Accepted-move statistics. Personal best score only counts `classic` games (practice/custom never
   * blends into bests). Decimal comparison by length then lexical value; never numeric casts.
   */
  recordProfileMove(
    db: DatabaseSync,
    userId: string,
    stats: { countsForBest: boolean; score: string; maxExponent: string | null; now: string },
  ): void {
    db.prepare(
      `UPDATE profiles SET
         accepted_moves = accepted_moves + 1,
         best_score = CASE WHEN $best = 1 AND (length($score) > length(best_score)
             OR (length($score) = length(best_score) AND $score > best_score)) THEN $score ELSE best_score END,
         max_exponent = CASE WHEN $best = 1 AND $max IS NOT NULL AND (max_exponent IS NULL
             OR length($max) > length(max_exponent)
             OR (length($max) = length(max_exponent) AND $max > max_exponent)) THEN $max ELSE max_exponent END,
         updated_at = $now
       WHERE user_id = $user`,
    ).run({
      best: stats.countsForBest ? 1 : 0,
      score: stats.score,
      max: stats.maxExponent,
      now: stats.now,
      user: userId,
    });
  },
};
