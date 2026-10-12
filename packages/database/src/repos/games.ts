import type { Database as SqliteDatabase } from "better-sqlite3";
import { compareDecimal, type Decimal, type Exponent, type GameMode, type GameState, type Ruleset } from "@2048/contracts";

type Raw = Record<string, unknown>;

export type GameMeta = {
  id: string;
  ownerUserId: string | null;
  ownerGuestId: string | null;
  mode: GameMode;
  rulesetVersion: string;
  engineVersion: string;
  seed: string;
  challengeId: string | null;
  matchId: string | null;
  seat: 0 | 1 | null;
  botLabel: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredGame = GameMeta & { state: GameState };

/** "end" = the system ended the game (a bot run finished its budget or was cancelled). */
export type CommandKind = "move" | "undo" | "forfeit" | "end";
export type CommandRow = {
  gameId: string;
  commandId: string;
  kind: CommandKind;
  requestHash: string;
  responseJson: string;
  revisionAfter: number;
};

export type MoveRow = {
  gameId: string;
  revision: number;
  commandId: string;
  kind: CommandKind;
  direction: "up" | "right" | "down" | "left" | null;
  acceptedMoves: number;
  eventsJson: string;
  checksum: string;
  createdAt: string;
};

export type SnapshotRow = { gameId: string; revision: number; stateJson: string; stateChecksum: string; createdAt: string };

/** Largest exponent on the board as a canonical decimal ("0" when empty). Never goes through Number. */
export function maxExponentOf(cells: readonly (Exponent | null)[]): Exponent | "0" {
  let best: Decimal = "0";
  for (const c of cells) if (c !== null && compareDecimal(c, best) > 0) best = c;
  return best;
}

function meta(r: Raw): GameMeta {
  return {
    id: r.id as string,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerGuestId: (r.owner_guest_id as string | null) ?? null,
    mode: r.mode as GameMode,
    rulesetVersion: r.ruleset_version as string,
    engineVersion: r.engine_version as string,
    seed: r.seed as string,
    challengeId: (r.challenge_id as string | null) ?? null,
    matchId: (r.match_id as string | null) ?? null,
    seat: (r.seat as 0 | 1 | null) ?? null,
    botLabel: (r.bot_label as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function stored(r: Raw): StoredGame {
  const cells = JSON.parse(r.cells_json as string) as (string | null)[];
  const state: GameState = {
    schemaVersion: 1,
    engineVersion: r.engine_version as string,
    rulesetVersion: r.ruleset_version as string,
    board: { size: r.board_size as number, cells },
    score: r.score as string,
    acceptedMoves: r.accepted_moves as number,
    revision: r.revision as number,
    rng: JSON.parse(r.rng_json as string) as GameState["rng"],
    status: r.status as GameState["status"],
    celebrated2048: (r.celebrated2048 as number) === 1,
  };
  return { ...meta(r), state };
}

export type ListGamesFilter = {
  ownerUserId?: string;
  ownerGuestId?: string;
  status?: "active" | "completed" | "forfeited";
  /** Keyset cursor: games strictly older than (updatedAt, id). */
  after?: { updatedAt: string; id: string };
  limit: number;
};

export function gameRepo(db: SqliteDatabase) {
  const insert = db.prepare(`INSERT INTO games (
    id, owner_user_id, owner_guest_id, mode, ruleset_version, engine_version, seed, board_size, cells_json, rng_json,
    score, max_exponent, accepted_moves, revision, status, celebrated2048, challenge_id, match_id, seat, bot_label, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE games SET cells_json = ?, rng_json = ?, score = ?, max_exponent = ?, accepted_moves = ?,
    revision = ?, status = ?, celebrated2048 = ?, updated_at = ? WHERE id = ?`);
  const byId = db.prepare("SELECT * FROM games WHERE id = ?");
  const rulesetInsert = db.prepare("INSERT OR IGNORE INTO rulesets (version, rules_json, digest, created_at) VALUES (?, ?, ?, ?)");
  const cmdGet = db.prepare("SELECT * FROM game_commands WHERE game_id = ? AND command_id = ?");
  const cmdInsert = db.prepare(
    "INSERT INTO game_commands (game_id, command_id, kind, request_hash, response_json, revision_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const moveInsert = db.prepare(
    `INSERT INTO game_moves (game_id, revision, command_id, kind, direction, accepted_moves, events_json, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const moveAt = db.prepare("SELECT checksum, kind FROM game_moves WHERE game_id = ? AND revision = ?");
  const allMoves = db.prepare(
    "SELECT game_id, revision, command_id, kind, direction, accepted_moves, checksum, created_at FROM game_moves WHERE game_id = ? ORDER BY revision",
  );
  const allSnaps = db.prepare("SELECT * FROM game_snapshots WHERE game_id = ? ORDER BY revision");
  const movesAfter = db.prepare(
    "SELECT * FROM game_moves WHERE game_id = ? AND revision > ? AND kind = 'move' ORDER BY revision ASC LIMIT ?",
  );
  const snapInsert = db.prepare(
    "INSERT OR IGNORE INTO game_snapshots (game_id, revision, state_json, state_checksum, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const snapNearest = db.prepare(
    "SELECT * FROM game_snapshots WHERE game_id = ? AND revision <= ? ORDER BY revision DESC LIMIT 1",
  );
  const undoPush = db.prepare("INSERT OR REPLACE INTO game_undo_stack (game_id, accepted_moves, state_json) VALUES (?, ?, ?)");
  const undoTop = db.prepare("SELECT accepted_moves, state_json FROM game_undo_stack WHERE game_id = ? ORDER BY accepted_moves DESC LIMIT 1");
  const undoPop = db.prepare("DELETE FROM game_undo_stack WHERE game_id = ? AND accepted_moves = ?");
  const undoTrim = db.prepare("DELETE FROM game_undo_stack WHERE game_id = ? AND accepted_moves <= ?");
  const undoCount = db.prepare("SELECT count(*) AS n FROM game_undo_stack WHERE game_id = ?").pluck();
  const undoClear = db.prepare("DELETE FROM game_undo_stack WHERE game_id = ?");

  return {
    /** Rulesets are immutable; inserting an existing version is a no-op. */
    ensureRuleset(rules: Ruleset, digest: string, at: string): void {
      rulesetInsert.run(rules.version, JSON.stringify(rules), digest, at);
    },

    insertGame(g: Omit<GameMeta, "updatedAt" | "engineVersion" | "rulesetVersion" | "botLabel"> & { botLabel?: string | null; state: GameState }): void {
      const s = g.state;
      insert.run(
        g.id, g.ownerUserId, g.ownerGuestId, g.mode, s.rulesetVersion, s.engineVersion, g.seed, s.board.size,
        JSON.stringify(s.board.cells), JSON.stringify(s.rng), s.score, maxExponentOf(s.board.cells), s.acceptedMoves,
        s.revision, s.status, s.celebrated2048 ? 1 : 0, g.challengeId, g.matchId, g.seat, g.botLabel ?? null, g.createdAt, g.createdAt,
      );
    },

    saveState(id: string, s: GameState, at: string): void {
      const r = update.run(
        JSON.stringify(s.board.cells), JSON.stringify(s.rng), s.score, maxExponentOf(s.board.cells), s.acceptedMoves,
        s.revision, s.status, s.celebrated2048 ? 1 : 0, at, id,
      );
      if (r.changes !== 1) throw new Error(`game ${id} not found`);
    },

    get(id: string): StoredGame | undefined {
      const r = byId.get(id) as Raw | undefined;
      return r ? stored(r) : undefined;
    },

    list(f: ListGamesFilter): StoredGame[] {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.ownerUserId !== undefined) {
        where.push("owner_user_id = ?");
        args.push(f.ownerUserId);
      }
      if (f.ownerGuestId !== undefined) {
        where.push("owner_guest_id = ?");
        args.push(f.ownerGuestId);
      }
      if (f.status) {
        where.push("status = ?");
        args.push(f.status);
      }
      if (f.after) {
        where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
        args.push(f.after.updatedAt, f.after.updatedAt, f.after.id);
      }
      args.push(f.limit);
      const sql = `SELECT * FROM games ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`;
      return (db.prepare(sql).all(...args) as Raw[]).map(stored);
    },

    getCommand(gameId: string, commandId: string): CommandRow | undefined {
      const r = cmdGet.get(gameId, commandId) as Raw | undefined;
      if (!r) return undefined;
      return {
        gameId: r.game_id as string,
        commandId: r.command_id as string,
        kind: r.kind as CommandKind,
        requestHash: r.request_hash as string,
        responseJson: r.response_json as string,
        revisionAfter: r.revision_after as number,
      };
    },
    insertCommand(c: CommandRow, at: string): void {
      cmdInsert.run(c.gameId, c.commandId, c.kind, c.requestHash, c.responseJson, c.revisionAfter, at);
    },
    insertMove(m: MoveRow): void {
      moveInsert.run(m.gameId, m.revision, m.commandId, m.kind, m.direction, m.acceptedMoves, m.eventsJson, m.checksum, m.createdAt);
    },
    /** Complete move log in revision order (moves, undo markers, forfeit/end markers). */
    allMoves(gameId: string): MoveRow[] {
      return (allMoves.all(gameId) as Raw[]).map((r) => ({
        gameId: r.game_id as string,
        revision: r.revision as number,
        commandId: r.command_id as string,
        kind: r.kind as CommandKind,
        direction: (r.direction as MoveRow["direction"]) ?? null,
        acceptedMoves: r.accepted_moves as number,
        eventsJson: "[]",
        checksum: r.checksum as string,
        createdAt: r.created_at as string,
      }));
    },
    snapshots(gameId: string): SnapshotRow[] {
      return (allSnaps.all(gameId) as Raw[]).map((r) => ({
        gameId: r.game_id as string,
        revision: r.revision as number,
        stateJson: r.state_json as string,
        stateChecksum: r.state_checksum as string,
        createdAt: r.created_at as string,
      }));
    },
    checksumAt(gameId: string, revision: number): string | undefined {
      const r = moveAt.get(gameId, revision) as { checksum: string } | undefined;
      return r?.checksum;
    },
    movesAfter(gameId: string, afterRevision: number, limit: number): MoveRow[] {
      return (movesAfter.all(gameId, afterRevision, limit) as Raw[]).map((r) => ({
        gameId: r.game_id as string,
        revision: r.revision as number,
        commandId: r.command_id as string,
        kind: r.kind as CommandKind,
        direction: (r.direction as MoveRow["direction"]) ?? null,
        acceptedMoves: r.accepted_moves as number,
        eventsJson: r.events_json as string,
        checksum: r.checksum as string,
        createdAt: r.created_at as string,
      }));
    },
    insertSnapshot(s: SnapshotRow): void {
      snapInsert.run(s.gameId, s.revision, s.stateJson, s.stateChecksum, s.createdAt);
    },
    nearestSnapshot(gameId: string, atOrBeforeRevision: number): SnapshotRow | undefined {
      const r = snapNearest.get(gameId, atOrBeforeRevision) as Raw | undefined;
      if (!r) return undefined;
      return {
        gameId: r.game_id as string,
        revision: r.revision as number,
        stateJson: r.state_json as string,
        stateChecksum: r.state_checksum as string,
        createdAt: r.created_at as string,
      };
    },

    /** Undo history: the state BEFORE each accepted move, keyed by that state's acceptedMoves. Capped by `limit`. */
    pushUndo(gameId: string, stateBefore: GameState, limit: number): void {
      undoPush.run(gameId, stateBefore.acceptedMoves, JSON.stringify(stateBefore));
      undoTrim.run(gameId, stateBefore.acceptedMoves - limit);
    },
    peekUndo(gameId: string): { acceptedMoves: number; stateJson: string } | undefined {
      const r = undoTop.get(gameId) as Raw | undefined;
      return r ? { acceptedMoves: r.accepted_moves as number, stateJson: r.state_json as string } : undefined;
    },
    popUndo(gameId: string, acceptedMoves: number): void {
      undoPop.run(gameId, acceptedMoves);
    },
    undoDepth: (gameId: string) => undoCount.get(gameId) as number,
    clearUndo: (gameId: string) => void undoClear.run(gameId),
  };
}

export type GameRepo = ReturnType<typeof gameRepo>;
