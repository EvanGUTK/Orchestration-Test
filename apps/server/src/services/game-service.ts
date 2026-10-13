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
import type { EventBus } from "./event-bus.js";

export type CreateGameInput = ReturnType<(typeof CreateGameRequest)["parse"]>;
export type MoveCommandInput = { commandId: string; expectedRevision: number; direction: Direction };
export type RevisionCommandInput = { commandId: string; expectedRevision: number };

/**
 * Who may act on a game through an internal call. `owner: null` means the calling service has
 * already authorized the actor (e.g. a duel seat check); `allowedModes` restricts which game modes
 * the call may touch: a game of any other mode is reported as NOT_FOUND.
 */
export type GameAccess = { owner: GameOwnerRef | null; allowedModes: readonly GameMode[] };

/** Modes the generic HTTP routes may READ (`GET /games/:id`, `/events`). */
export const HTTP_READ_MODES: readonly GameMode[] = ["classic", "practice", "ranked", "bot-exhibition"];
/**
 * Modes the generic HTTP routes may COMMAND (moves/undo/forfeit). `ranked` is delegated here with
 * its own ruleset policy (no undo, 500-move cap) and the challenge-attempt terminal hook. Duel and
 * bot games are never reachable through the generic routes (SEC-FIX-002 R2-02).
 */
export const HTTP_COMMAND_MODES: readonly GameMode[] = ["classic", "practice", "ranked"];
/** Modes shown in the resumable-games list and counted against the active-games cap. */
export const RESUMABLE_MODES: readonly GameMode[] = ["classic", "practice", "ranked"];
/** Competitive modes whose responses omit the PRNG state (SEC-FIX-002 R2-06). */
const RNG_REDACTED_MODES: ReadonlySet<GameMode> = new Set(["ranked", "duel-human", "duel-bot", "bot-vs-bot"]);
/** Unfinished human games per owner (SEC-FIX-002 R2-05). */
export const MAX_ACTIVE_GAMES_PER_OWNER = 25;
/** No-change command rows kept per game for idempotent retries (older no-op retries re-evaluate). */
export const NO_CHANGE_RETENTION = 100;

export type TerminalReason = "move-cap" | "dead-board" | "forfeit";
/** Runs INSIDE the transaction that ended the game (e.g. to finalize a challenge attempt). */
export type TerminalListener = (
  db: DatabaseSync,
  game: GameRecord,
  finalState: GameState,
  reason: TerminalReason,
) => void;

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

/** Public view of a state: competitive modes omit `rng` so clients cannot look ahead at spawns. */
export function publicState(mode: GameMode, state: GameState): GameState {
  if (!RNG_REDACTED_MODES.has(mode)) return state;
  const { rng: _rng, ...rest } = state;
  return rest as unknown as GameState;
}

/**
 * Authoritative games (ARCHITECTURE "Transactions and concurrency", "Save / replay / restart").
 *
 * Every command runs as ONE synchronous writer transaction:
 *   access (owner + allowed mode) -> stored commandId (same payload: stored response; different:
 *   IDEMPOTENCY_CONFLICT) -> expectedRevision (REVISION_CONFLICT) -> mode/state policy -> pure engine
 *   transition -> game_commands + game_moves (+ snapshot) + games row + profile statistics
 *   (+ terminal listeners) and a `game.updated` event published after COMMIT.
 * No-op moves are recorded in game_commands only (no revision/PRNG change). Every accepted command
 * advances `revision` by one and appends a game_moves record with the post-state checksum. Snapshots
 * are written at creation, every SNAPSHOT_INTERVAL revisions, and at every undo/forfeit/terminal
 * state, so the log after the nearest snapshot is always plain moves.
 *
 * Internal `*InTransaction` methods take the caller's writer transaction and a GameAccess; they are
 * the port for ranked/duel/bot services. HTTP-facing methods wrap them with the HTTP mode allowlists.
 */
export class GameService {
  readonly #ctx: ServiceContext;
  readonly #events: EventBus | null;
  readonly #terminalListeners: TerminalListener[] = [];

  constructor(ctx: ServiceContext, events: EventBus | null = null) {
    this.#ctx = ctx;
    this.#events = events;
  }

  /** Registers a listener invoked inside the transaction that ends a game. */
  onTerminal(listener: TerminalListener): void {
    this.#terminalListeners.push(listener);
  }

  // ---------- HTTP-facing (generic /games routes) ----------

  async create(owner: GameOwnerRef, input: CreateGameInput): Promise<GameResponse> {
    const rules: Ruleset =
      input.mode === "practice" ? practiceRuleset(input.practice) : RULESETS[MODE_RULESET.classic];
    const seed = (input.mode === "practice" ? input.practice.seed : input.seed) ?? randomUUID();
    return this.#ctx.writer.run((db) => {
      const record = this.createInTransaction(db, owner, { mode: input.mode, rules, seed });
      return this.#response(db, record);
    });
  }

  list(owner: GameOwnerRef, query: { cursor?: string | undefined; limit: number }): Page<GameSummary> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = gamesRepo.listOwned(this.#ctx.db, owner, "active", RESUMABLE_MODES, after, query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.#summary(r)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  get(owner: GameOwnerRef, id: string): GameResponse {
    return this.readInTransaction(this.#ctx.db, id, { owner, allowedModes: HTTP_READ_MODES });
  }

  events(
    owner: GameOwnerRef,
    id: string,
    query: { afterRevision: number; limit: number },
  ): GameEventsResponse {
    return this.eventsInTransaction(this.#ctx.db, id, query, { owner, allowedModes: HTTP_READ_MODES });
  }

  move(owner: GameOwnerRef, id: string, command: MoveCommandInput): Promise<MoveResponse> {
    return this.#ctx.writer.run((db) =>
      this.moveInTransaction(db, id, command, { owner, allowedModes: HTTP_COMMAND_MODES }),
    );
  }

  undo(owner: GameOwnerRef, id: string, command: RevisionCommandInput): Promise<GameResponse> {
    return this.#ctx.writer.run((db) =>
      this.undoInTransaction(db, id, command, { owner, allowedModes: HTTP_COMMAND_MODES }),
    );
  }

  forfeit(owner: GameOwnerRef, id: string, command: RevisionCommandInput): Promise<GameResponse> {
    return this.#ctx.writer.run((db) =>
      this.forfeitInTransaction(db, id, command, { owner, allowedModes: HTTP_COMMAND_MODES }),
    );
  }

  // ---------- internal port (call inside writer.run / on the read connection) ----------

  /**
   * Creates a game inside the caller's writer transaction (ranked attempts, duel seats, bot games).
   * `owner: null` creates an unowned game (bot-vs-bot seats). Human-resumable modes are capped at
   * MAX_ACTIVE_GAMES_PER_OWNER unfinished games per owner.
   */
  createInTransaction(
    db: DatabaseSync,
    owner: GameOwnerRef | null,
    spec: { mode: GameMode; rules: Ruleset; seed: string; id?: string },
  ): GameRecord {
    if (owner && RESUMABLE_MODES.includes(spec.mode)) {
      if (gamesRepo.countActiveOwned(db, owner, RESUMABLE_MODES) >= MAX_ACTIVE_GAMES_PER_OWNER) {
        throw new AppError(
          "RESOURCE_LIMIT",
          `At most ${MAX_ACTIVE_GAMES_PER_OWNER} unfinished games; finish or forfeit one first`,
        );
      }
    }
    const state = newGame(spec.rules, spec.seed);
    const sum = checksum(state);
    const now = nowIso(this.#ctx);
    const id = spec.id ?? randomUUID();
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
    if (owner && "userId" in owner) gamesRepo.bumpProfileGamesStarted(db, owner.userId, now);
    const record = gamesRepo.get(db, id);
    if (!record) throw new Error("created game not found");
    this.#publish(record, "create");
    return record;
  }

  readInTransaction(db: DatabaseSync, id: string, access: GameAccess): GameResponse {
    return this.#response(db, this.#load(db, id, access));
  }

  eventsInTransaction(
    db: DatabaseSync,
    id: string,
    query: { afterRevision: number; limit: number },
    access: GameAccess,
  ): GameEventsResponse {
    this.#load(db, id, access);
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

  moveInTransaction(
    db: DatabaseSync,
    id: string,
    command: MoveCommandInput,
    access: GameAccess,
  ): MoveResponse {
    const hash = payloadHash({
      kind: "move",
      direction: command.direction,
      expectedRevision: command.expectedRevision,
    });
    const record = this.#load(db, id, access);
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
        state: publicState(record.mode, record.state),
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
      gamesRepo.pruneNoChangeCommands(db, id, NO_CHANGE_RETENTION);
      return response;
    }
    const next = result.state;
    const sum = checksum(next);
    const response: MoveResponse = {
      changed: true,
      scoreDelta: result.scoreDelta,
      state: publicState(record.mode, next),
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
    // Bounded undo stack: push, dropping the oldest beyond the history limit (C11 / SEC-R2-07).
    const undoAvailable = rules.undo ? Math.min(record.undoAvailable + 1, rules.historyLimit) : 0;
    this.#writeState(db, record, next, sum, max, now, undoAvailable);
    if (record.ownerUserId) {
      gamesRepo.recordProfileMove(db, record.ownerUserId, {
        countsForBest: record.mode === "classic",
        score: next.score,
        maxExponent: max,
        now,
      });
    }
    if (next.status !== "active") {
      const capped = rules.moveCap !== null && next.acceptedMoves >= rules.moveCap;
      this.#terminal(db, record, next, capped ? "move-cap" : "dead-board");
    }
    this.#publish({ ...record, state: next }, "move");
    return response;
  }

  /**
   * Casual undo: pops the bounded undo stack, restoring the complete prior state (board, score, PRNG
   * words, counters) at a NEW revision. The undone move keeps its log record, marked `undone`, so
   * replays of the final path exclude it. Not allowed by the ruleset -> 403; nothing (left) to undo
   * within the history limit -> 400 VALIDATION_ERROR (CONTRACT-001 C11).
   */
  undoInTransaction(
    db: DatabaseSync,
    id: string,
    command: RevisionCommandInput,
    access: GameAccess,
  ): GameResponse {
    const hash = payloadHash({ kind: "undo", expectedRevision: command.expectedRevision });
    const record = this.#load(db, id, access);
    const replayed = this.#idempotent<GameResponse>(db, id, command.commandId, hash);
    if (replayed) return replayed;
    this.#checkRevision(record, command.expectedRevision);
    const rules = this.#rules(record);
    if (!rules.undo) throw new AppError("FORBIDDEN", "Undo is not available in this mode");
    if (record.state.status === "forfeited")
      throw new AppError("FORBIDDEN", "A forfeited game cannot be undone");
    const target = gamesRepo.lastActiveMove(db, id);
    if (!target) throw new AppError("VALIDATION_ERROR", "There is no move to undo");
    if (record.undoAvailable <= 0) {
      throw new AppError("VALIDATION_ERROR", `Undo history is limited to ${rules.historyLimit} moves`);
    }
    const prior = this.#stateAt(db, record, rules, target.revision - 1);
    const restored: GameState = { ...prior, revision: record.state.revision + 1 };
    const sum = checksum(restored);
    const now = nowIso(this.#ctx);
    if (!gamesRepo.markUndone(db, id, target.revision))
      throw new GameIntegrityError(id, "undo target vanished");
    const response = this.#commitSpecial(db, record, command.commandId, hash, {
      kind: "undo",
      restored,
      sum,
      now,
      undoAvailable: record.undoAvailable - 1,
    });
    this.#publish({ ...record, state: restored }, "undo");
    return response;
  }

  /** Ends the game exactly once (status "forfeited"; board/score/PRNG unchanged). */
  forfeitInTransaction(
    db: DatabaseSync,
    id: string,
    command: RevisionCommandInput,
    access: GameAccess,
  ): GameResponse {
    const hash = payloadHash({ kind: "forfeit", expectedRevision: command.expectedRevision });
    const record = this.#load(db, id, access);
    const replayed = this.#idempotent<GameResponse>(db, id, command.commandId, hash);
    if (replayed) return replayed;
    this.#checkRevision(record, command.expectedRevision);
    if (record.state.status !== "active") throw new AppError("FORBIDDEN", "Game is not active");
    const ended: GameState = { ...engineForfeit(record.state), revision: record.state.revision + 1 };
    const now = nowIso(this.#ctx);
    this.#terminal(db, record, ended, "forfeit");
    const response = this.#commitSpecial(db, record, command.commandId, hash, {
      kind: "forfeit",
      restored: ended,
      sum: checksum(ended),
      now,
      undoAvailable: 0,
    });
    this.#publish({ ...record, state: ended }, "forfeit");
    return response;
  }

  /** State of game `id` at `revision`, rebuilt from the nearest snapshot (checksums verified). */
  stateAtInTransaction(db: DatabaseSync, id: string, revision: number): GameState {
    const record = gamesRepo.get(db, id);
    if (!record) throw notFound();
    return this.#stateAt(db, record, this.#rules(record), revision);
  }

  rulesOf(record: GameRecord): Ruleset {
    return this.#rules(record);
  }

  // ---------- integrity ----------

  /**
   * Rebuilds the current state from the nearest snapshot plus the move log and compares every
   * checksum with what was stored. Used at boot for resumable games and on demand (CLI verify-games).
   */
  verifyIntegrity(id: string): IntegrityReport {
    const { db } = this.#ctx;
    const record = gamesRepo.get(db, id);
    if (!record) {
      return {
        gameId: id,
        ok: false,
        revision: -1,
        snapshotRevision: null,
        replayedMoves: 0,
        error: "missing",
      };
    }
    const revision = record.state.revision;
    const snapshot = gamesRepo.latestSnapshotAtOrBefore(db, id, revision);
    try {
      if (checksum(record.state) !== record.stateChecksum) throw new Error("current state checksum mismatch");
      const state = this.#stateAt(db, record, this.#rules(record), revision);
      if (canonicalJson(state) !== canonicalJson(record.state)) {
        throw new Error("replayed state differs from saved state");
      }
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

  #load(db: DatabaseSync, id: string, access: GameAccess): GameRecord {
    if (!UUID.test(id)) throw notFound();
    const record = gamesRepo.get(db, id);
    // Never reveal other owners' games or games of modes this caller may not touch.
    if (!record || !access.allowedModes.includes(record.mode)) throw notFound();
    if (access.owner && !owns(record, access.owner)) throw notFound();
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

  #terminal(db: DatabaseSync, record: GameRecord, finalState: GameState, reason: TerminalReason): void {
    for (const listener of this.#terminalListeners) listener(db, record, finalState, reason);
  }

  #publish(record: GameRecord, kind: "create" | "move" | "undo" | "forfeit"): void {
    this.#events?.publishAfterCommit({
      type: "game.updated",
      resourceId: record.id,
      sequence: record.state.revision,
      payload: { gameId: record.id, kind, revision: record.state.revision, status: record.state.status },
    });
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
    undoAvailable: number,
  ): void {
    if (!gamesRepo.updateState(db, record.id, record.state.revision, next, sum, max, now, undoAvailable)) {
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
    pending: {
      kind: "undo" | "forfeit";
      restored: GameState;
      sum: string;
      now: string;
      undoAvailable: number;
    },
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
      responseJson: "{}", // filled in below, inside the same transaction (FK: command row first)
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
    this.#writeState(db, record, restored, sum, maxExponent(restored.board), now, pending.undoAvailable);
    const updated = gamesRepo.get(db, record.id);
    if (!updated) throw new GameIntegrityError(record.id, "game vanished");
    const response = this.#response(db, updated);
    gamesRepo.setCommandResponse(db, record.id, commandId, JSON.stringify(response));
    return response;
  }

  #canUndo(db: DatabaseSync, record: GameRecord): boolean {
    const rules = this.#rules(record);
    if (!rules.undo || record.state.status === "forfeited" || record.undoAvailable <= 0) return false;
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
    return {
      game: this.#summary(record),
      state: publicState(record.mode, record.state),
      canUndo: this.#canUndo(db, record),
    };
  }
}
