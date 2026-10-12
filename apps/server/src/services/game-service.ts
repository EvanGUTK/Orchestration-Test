import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MODE_RULESET,
  RULESETS,
  SNAPSHOT_INTERVAL,
  practiceRuleset,
  type CreateGameRequest,
  type Direction,
  type DomainEvent,
  type GameEventRecord,
  type GameEventsResponse,
  type GameMode,
  type GameResponse,
  type GameState,
  type GameSummary,
  type MoveResponse,
  type Page,
  type Ruleset,
} from "@g2048/contracts";
import { canonicalRulesetJson, gamesRepo, type GameOwnerRef, type GameRecord } from "@g2048/database";
import {
  applyMove,
  canonicalJson,
  checksum,
  deserialize,
  forfeit as engineForfeit,
  maxExponent,
  newGame,
  validateRuleset,
} from "@g2048/engine";
import { AppError } from "../http/errors.js";
import type { ServiceContext } from "./context.js";
import { nowIso } from "./context.js";

export type CreateGameInput = ReturnType<(typeof CreateGameRequest)["parse"]>;
export type MoveCommandInput = { commandId: string; expectedRevision: number; direction: Direction };
export type RevisionCommandInput = { commandId: string; expectedRevision: number };

export type IntegrityReport = {
  gameId: string;
  ok: boolean;
  revision: number;
  snapshotRevision: number | null;
  replayedMoves: number;
  error?: string;
};

/** Raised when stored game data does not verify; surfaces as a logged 500, never silently repaired. */
export class GameIntegrityError extends Error {
  constructor(gameId: string, detail: string) {
    super(`Game ${gameId} failed integrity verification: ${detail}`);
    this.name = "GameIntegrityError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function payloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Game not found");
}

function owns(record: GameRecord, owner: GameOwnerRef): boolean {
  return "userId" in owner ? record.ownerUserId === owner.userId : record.ownerGuestId === owner.guestId;
}

function encodeCursor(record: GameRecord): string {
  return Buffer.from(JSON.stringify({ u: record.updatedAt, i: record.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      u?: unknown;
      i?: unknown;
    };
    if (typeof parsed.u === "string" && typeof parsed.i === "string")
      return { updatedAt: parsed.u, id: parsed.i };
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_ERROR", "Invalid cursor", { field: "cursor" });
}

/**
 * Authoritative games (ARCHITECTURE "Transactions and concurrency", "Save / replay / restart").
 *
 * Every command runs as ONE synchronous writer transaction:
 *   ownership -> stored commandId (same payload: stored response; different: IDEMPOTENCY_CONFLICT)
 *   -> expectedRevision (REVISION_CONFLICT) -> pure engine transition -> game_commands + game_moves
 *   (+ snapshot) + games row + profile statistics.
 * No-op moves are recorded in game_commands only (no revision/PRNG change). Every accepted command
 * (move, undo, forfeit) advances `revision` by one and appends a game_moves record with the
 * post-state checksum. Snapshots are written at creation, every SNAPSHOT_INTERVAL revisions, and at
 * every undo/forfeit, so the log after the nearest snapshot is always plain moves and any state can be
 * rebuilt (and verified) by replaying from that snapshot.
 */
export class GameService {
  readonly #ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.#ctx = ctx;
  }

  // ---------- creation ----------

  async create(owner: GameOwnerRef, input: CreateGameInput): Promise<GameResponse> {
    const rules: Ruleset =
      input.mode === "practice" ? practiceRuleset(input.practice) : RULESETS[MODE_RULESET.classic];
    const seed = (input.mode === "practice" ? input.practice.seed : input.seed) ?? randomUUID();
    return this.#ctx.writer.run((db) => {
      const record = this.createInTransaction(db, owner, { mode: input.mode, rules, seed });
      return this.#response(db, record);
    });
  }

  /**
   * Creates a game inside the caller's writer transaction. Also the port for later features
   * (ranked challenge attempts, duel seats) that create games with their own mode/rules/seed.
   */
  createInTransaction(
    db: DatabaseSync,
    owner: GameOwnerRef,
    spec: { mode: GameMode; rules: Ruleset; seed: string },
  ): GameRecord {
    const state = newGame(spec.rules, spec.seed);
    const sum = checksum(state);
    const now = nowIso(this.#ctx);
    const id = randomUUID();
    gamesRepo.insert(db, {
      id,
      owner,
      mode: spec.mode,
      rulesJson: canonicalRulesetJson(spec.rules),
      seed: spec.seed,
      state,
      checksum: sum,
      maxExponent: maxExponent(state.board),
      now,
    });
    gamesRepo.insertSnapshot(db, {
      gameId: id,
      revision: 0,
      stateJson: canonicalJson(state),
      score: state.score,
      checksum: sum,
      now,
    });
    if ("userId" in owner) gamesRepo.bumpProfileGamesStarted(db, owner.userId, now);
    const record = gamesRepo.get(db, id);
    if (!record) throw new Error("created game not found");
    return record;
  }

  // ---------- reads ----------

  list(owner: GameOwnerRef, query: { cursor?: string | undefined; limit: number }): Page<GameSummary> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = gamesRepo.listOwned(this.#ctx.db, owner, "active", after, query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.#summary(r)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  get(owner: GameOwnerRef, id: string): GameResponse {
    const record = this.#load(this.#ctx.db, owner, id);
    return this.#response(this.#ctx.db, record);
  }

  events(
    owner: GameOwnerRef,
    id: string,
    query: { afterRevision: number; limit: number },
  ): GameEventsResponse {
    const { db } = this.#ctx;
    this.#load(db, owner, id);
    const rows = gamesRepo.eventsPage(db, id, query.afterRevision, query.limit + 1);
    const page = rows.slice(0, query.limit);
    const events: GameEventRecord[] = page.map((r) => ({
      revision: r.revision,
      kind: r.kind,
      direction: r.direction,
      events: JSON.parse(r.eventsJson) as DomainEvent[],
      checksum: r.checksum,
    }));
    const last = page[page.length - 1];
    return {
      events,
      nextAfterRevision: last ? last.revision : query.afterRevision,
      done: rows.length <= query.limit,
    };
  }

  // ---------- commands ----------

  async move(owner: GameOwnerRef, id: string, command: MoveCommandInput): Promise<MoveResponse> {
    const hash = payloadHash({
      kind: "move",
      direction: command.direction,
      expectedRevision: command.expectedRevision,
    });
    return this.#ctx.writer.run((db) => {
      const record = this.#load(db, owner, id);
      const replayed = this.#idempotent<MoveResponse>(db, id, command.commandId, hash);
      if (replayed) return replayed;
      this.#checkRevision(record, command.expectedRevision);
      const rules = this.#rules(record);
      if (record.state.status !== "active") throw new AppError("FORBIDDEN", "Game is not active");
      const result = applyMove(record.state, command.direction, rules);
      const now = nowIso(this.#ctx);
      if (!result.changed) {
        const response: MoveResponse = {
          changed: false,
          scoreDelta: "0",
          state: record.state,
          events: [],
          code: "NO_CHANGE",
        };
        gamesRepo.insertCommand(db, {
          gameId: id,
          commandId: command.commandId,
          kind: "move",
          payloadHash: hash,
          outcome: "no-change",
          revisionBefore: record.state.revision,
          revisionAfter: record.state.revision,
          responseJson: JSON.stringify(response),
          now,
        });
        return response;
      }
      const next = result.state;
      const sum = checksum(next);
      const response: MoveResponse = {
        changed: true,
        scoreDelta: result.scoreDelta,
        state: next,
        events: [...result.events],
      };
      gamesRepo.insertCommand(db, {
        gameId: id,
        commandId: command.commandId,
        kind: "move",
        payloadHash: hash,
        outcome: "applied",
        revisionBefore: record.state.revision,
        revisionAfter: next.revision,
        responseJson: JSON.stringify(response),
        now,
      });
      gamesRepo.insertMove(db, {
        gameId: id,
        revision: next.revision,
        commandId: command.commandId,
        kind: "move",
        direction: command.direction,
        scoreDelta: result.scoreDelta,
        eventsJson: JSON.stringify(result.events),
        checksum: sum,
        now,
      });
      const max = maxExponent(next.board);
      const lastSnapshot = gamesRepo.latestSnapshotAtOrBefore(db, id, next.revision);
      if (
        !lastSnapshot ||
        next.revision - lastSnapshot.revision >= SNAPSHOT_INTERVAL ||
        next.status !== "active"
      ) {
        this.#snapshot(db, id, next, sum, now);
      }
      this.#writeState(db, record, next, sum, max, now);
      if (record.ownerUserId) {
        gamesRepo.recordProfileMove(db, record.ownerUserId, {
          countsForBest: record.mode === "classic",
          score: next.score,
          maxExponent: max,
          now,
        });
      }
      return response;
    });
  }

  /**
   * Casual undo: reverts the latest still-active move, restoring the complete prior state (board,
   * score, PRNG words, counters) at a NEW revision. The undone move keeps its log record, marked
   * `undone`, so replays of the final path exclude it.
   */
  async undo(owner: GameOwnerRef, id: string, command: RevisionCommandInput): Promise<GameResponse> {
    const hash = payloadHash({ kind: "undo", expectedRevision: command.expectedRevision });
    return this.#ctx.writer.run((db) => {
      const record = this.#load(db, owner, id);
      const replayed = this.#idempotent<GameResponse>(db, id, command.commandId, hash);
      if (replayed) return replayed;
      this.#checkRevision(record, command.expectedRevision);
      const rules = this.#rules(record);
      if (!rules.undo) throw new AppError("FORBIDDEN", "Undo is not available in this mode");
      if (record.state.status === "forfeited")
        throw new AppError("FORBIDDEN", "A forfeited game cannot be undone");
      if (gamesRepo.trailingUndoCount(db, id, rules.historyLimit) >= rules.historyLimit) {
        throw new AppError("FORBIDDEN", `Undo history is limited to ${rules.historyLimit} moves`);
      }
      const target = gamesRepo.lastActiveMove(db, id);
      if (!target) throw new AppError("VALIDATION_ERROR", "There is no move to undo");
      const prior = this.#stateAt(db, record, rules, target.revision - 1);
      const restored: GameState = { ...prior, revision: record.state.revision + 1 };
      const sum = checksum(restored);
      const now = nowIso(this.#ctx);
      if (!gamesRepo.markUndone(db, id, target.revision))
        throw new GameIntegrityError(id, "undo target vanished");
      const pending = { kind: "undo" as const, restored, sum, now };
      return this.#commitSpecial(db, record, command.commandId, hash, pending);
    });
  }

  /** Ends the caller's game exactly once (status "forfeited"; board/score/PRNG unchanged). */
  async forfeit(owner: GameOwnerRef, id: string, command: RevisionCommandInput): Promise<GameResponse> {
    const hash = payloadHash({ kind: "forfeit", expectedRevision: command.expectedRevision });
    return this.#ctx.writer.run((db) => {
      const record = this.#load(db, owner, id);
      const replayed = this.#idempotent<GameResponse>(db, id, command.commandId, hash);
      if (replayed) return replayed;
      this.#checkRevision(record, command.expectedRevision);
      if (record.state.status !== "active") throw new AppError("FORBIDDEN", "Game is not active");
      const ended: GameState = { ...engineForfeit(record.state), revision: record.state.revision + 1 };
      const pending = {
        kind: "forfeit" as const,
        restored: ended,
        sum: checksum(ended),
        now: nowIso(this.#ctx),
      };
      return this.#commitSpecial(db, record, command.commandId, hash, pending);
    });
  }

  // ---------- integrity ----------

  /**
   * Rebuilds the current state from the nearest snapshot plus the move log and compares every
   * checksum with what was stored. Used at boot for resumable games and on demand (CLI verify-games).
   */
  verifyIntegrity(id: string): IntegrityReport {
    const { db } = this.#ctx;
    const record = gamesRepo.get(db, id);
    if (!record)
      return {
        gameId: id,
        ok: false,
        revision: -1,
        snapshotRevision: null,
        replayedMoves: 0,
        error: "missing",
      };
    const revision = record.state.revision;
    const snapshot = gamesRepo.latestSnapshotAtOrBefore(db, id, revision);
    try {
      if (checksum(record.state) !== record.stateChecksum) throw new Error("current state checksum mismatch");
      const state = this.#stateAt(db, record, this.#rules(record), revision);
      if (canonicalJson(state) !== canonicalJson(record.state))
        throw new Error("replayed state differs from saved state");
      return {
        gameId: id,
        ok: true,
        revision,
        snapshotRevision: snapshot?.revision ?? null,
        replayedMoves: revision - (snapshot?.revision ?? 0),
      };
    } catch (error) {
      return {
        gameId: id,
        ok: false,
        revision,
        snapshotRevision: snapshot?.revision ?? null,
        replayedMoves: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  verifyActiveGames(): IntegrityReport[] {
    return gamesRepo.listIdsByStatus(this.#ctx.db, "active").map((id) => this.verifyIntegrity(id));
  }

  // ---------- internals ----------

  #load(db: DatabaseSync, owner: GameOwnerRef, id: string): GameRecord {
    if (!UUID.test(id)) throw notFound();
    const record = gamesRepo.get(db, id);
    if (!record || !owns(record, owner)) throw notFound(); // never reveal other owners' games
    if (checksum(record.state) !== record.stateChecksum)
      throw new GameIntegrityError(id, "state checksum mismatch");
    return record;
  }

  #rules(record: GameRecord): Ruleset {
    const rules: unknown = JSON.parse(record.rulesJson);
    validateRuleset(rules);
    return rules;
  }

  #idempotent<T>(db: DatabaseSync, gameId: string, commandId: string, hash: string): T | null {
    const existing = gamesRepo.findCommand(db, gameId, commandId);
    if (!existing) return null;
    if (existing.payloadHash !== hash) {
      throw new AppError("IDEMPOTENCY_CONFLICT", "This commandId was already used with a different request", {
        commandId,
      });
    }
    return JSON.parse(existing.responseJson) as T;
  }

  #checkRevision(record: GameRecord, expected: number): void {
    if (expected !== record.state.revision) {
      throw new AppError("REVISION_CONFLICT", "The game changed; reload and retry", {
        currentRevision: record.state.revision,
      });
    }
  }

  /** State at `revision`, rebuilt from the nearest snapshot by replaying plain moves (checksums verified). */
  #stateAt(db: DatabaseSync, record: GameRecord, rules: Ruleset, revision: number): GameState {
    const snapshot = gamesRepo.latestSnapshotAtOrBefore(db, record.id, revision);
    if (!snapshot) throw new GameIntegrityError(record.id, `no snapshot at or before revision ${revision}`);
    let state = deserialize(snapshot.stateJson);
    if (state.revision !== snapshot.revision || checksum(state) !== snapshot.checksum) {
      throw new GameIntegrityError(record.id, `snapshot ${snapshot.revision} does not verify`);
    }
    for (const entry of gamesRepo.movesBetween(db, record.id, snapshot.revision, revision)) {
      if (entry.kind !== "move" || entry.direction === null) {
        throw new GameIntegrityError(
          record.id,
          `unexpected ${entry.kind} record ${entry.revision} after snapshot`,
        );
      }
      const result = applyMove(state, entry.direction, rules);
      if (
        !result.changed ||
        result.state.revision !== entry.revision ||
        checksum(result.state) !== entry.checksum
      ) {
        throw new GameIntegrityError(record.id, `move ${entry.revision} does not replay to its checksum`);
      }
      state = result.state;
    }
    if (state.revision !== revision)
      throw new GameIntegrityError(record.id, `log ends before revision ${revision}`);
    return state;
  }

  #snapshot(db: DatabaseSync, gameId: string, state: GameState, sum: string, now: string): void {
    gamesRepo.insertSnapshot(db, {
      gameId,
      revision: state.revision,
      stateJson: canonicalJson(state),
      score: state.score,
      checksum: sum,
      now,
    });
  }

  #writeState(
    db: DatabaseSync,
    record: GameRecord,
    next: GameState,
    sum: string,
    max: string | null,
    now: string,
  ): void {
    if (!gamesRepo.updateState(db, record.id, record.state.revision, next, sum, max, now)) {
      throw new AppError("REVISION_CONFLICT", "The game changed; reload and retry", {
        currentRevision: gamesRepo.get(db, record.id)?.state.revision ?? null,
      });
    }
  }

  /** Shared tail of undo/forfeit: command + log record + snapshot + new state, then the response. */
  #commitSpecial(
    db: DatabaseSync,
    record: GameRecord,
    commandId: string,
    hash: string,
    pending: { kind: "undo" | "forfeit"; restored: GameState; sum: string; now: string },
  ): GameResponse {
    const { kind, restored, sum, now } = pending;
    gamesRepo.insertCommand(db, {
      gameId: record.id,
      commandId,
      kind,
      payloadHash: hash,
      outcome: "applied",
      revisionBefore: record.state.revision,
      revisionAfter: restored.revision,
      responseJson: "{}", // filled in below, inside the same transaction
      now,
    });
    gamesRepo.insertMove(db, {
      gameId: record.id,
      revision: restored.revision,
      commandId,
      kind,
      direction: null,
      scoreDelta: "0",
      eventsJson: "[]",
      checksum: sum,
      now,
    });
    this.#snapshot(db, record.id, restored, sum, now);
    this.#writeState(db, record, restored, sum, maxExponent(restored.board), now);
    const updated = gamesRepo.get(db, record.id);
    if (!updated) throw new GameIntegrityError(record.id, "game vanished");
    const response = this.#response(db, updated);
    gamesRepo.setCommandResponse(db, record.id, commandId, JSON.stringify(response));
    return response;
  }

  #canUndo(db: DatabaseSync, record: GameRecord): boolean {
    const rules = this.#rules(record);
    if (!rules.undo || record.state.status === "forfeited") return false;
    if (gamesRepo.trailingUndoCount(db, record.id, rules.historyLimit) >= rules.historyLimit) return false;
    return gamesRepo.lastActiveMove(db, record.id) !== null;
  }

  #summary(record: GameRecord): GameSummary {
    return {
      id: record.id,
      mode: record.mode,
      rulesetVersion: record.rulesetVersion,
      status: record.state.status,
      score: record.state.score,
      maxExponent: record.maxExponent,
      acceptedMoves: record.state.acceptedMoves,
      revision: record.state.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  #response(db: DatabaseSync, record: GameRecord): GameResponse {
    return { game: this.#summary(record), state: record.state, canUndo: this.#canUndo(db, record) };
  }
}
