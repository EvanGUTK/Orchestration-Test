import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BOT_DIFFICULTY,
  ELO,
  RULESETS,
  type BotConfig,
  type Direction,
  type GameMode,
  type GameState,
  type MatchView,
  type MoveResponse,
  type RandomState,
  type RatingEvent,
  type Ruleset,
  type SeatId,
  type SeatTerminalReason,
  type SeatView,
  type WsEventType,
} from "@g2048/contracts";
import { BOT_VERSION, deriveBotRng, engineAdapter } from "@g2048/bots";
import {
  applyRatingEvent,
  CompetitionError,
  createMatch,
  getRatingRecord,
  ratingKey,
  reduceMatch,
  type MatchCommand,
  type MatchState,
  type Participant,
  type RatingRecord,
  type SeasonsState,
} from "@g2048/competition";
import { competitionRepo, gamesRepo, type GameRecord } from "@g2048/database";
import { maxExponent } from "@g2048/engine";
import { AppError } from "../http/errors.js";
import type { ServiceContext } from "../services/context.js";
import { nowIso } from "../services/context.js";
import type { EventBus } from "../services/event-bus.js";
import type { GameAccess, GameService } from "../services/game-service.js";
import type { MatchEventLog } from "./event-log.js";
import { matchesRepo, type MatchRow, type SeatRow } from "./repo.js";

export type CreateMatchBody =
  | { kind: "human-human" }
  | { kind: "human-bot"; bot: BotConfig }
  | { kind: "bot-bot"; bots: [BotConfig, BotConfig]; seed?: string | undefined };

/** Game state without the PRNG words (CONTRACT-001 C20: duel responses omit state.rng). */
export type RedactedGameState = Omit<GameState, "rng">;

/** GET /matches/:id body: a MatchView plus the per-match WS sequence and each seat's redacted state. */
export type MatchDetail = MatchView & {
  sequence: number;
  /** Shared seed, shown only for bot-bot matches (league reproducibility). */
  seed: string | null;
  seatStates: { a: RedactedGameState | null; b: RedactedGameState | null };
};

export type BotSeatSnapshot = {
  match: MatchState;
  game: GameState;
  gameId: string;
  rules: Ruleset;
  config: BotConfig;
  botRng: RandomState;
};

type Bundle = {
  row: MatchRow;
  seats: Record<SeatId, SeatRow | null>;
  games: Record<SeatId, GameRecord | null>;
};

export const DUEL_MODES: readonly GameMode[] = ["duel-human", "duel-bot", "bot-vs-bot"];
/** Seat games are touched only through this service; the actor was authorized here first. */
const SEAT_ACCESS: GameAccess = { owner: null, allowedModes: DUEL_MODES };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNRATED = "unrated";

export function redact(state: GameState): RedactedGameState {
  const { rng: _rng, ...rest } = state as GameState & { rng?: unknown };
  return rest;
}

function rulesFor(row: MatchRow): Ruleset {
  const rules = (RULESETS as Record<string, Ruleset>)[row.rulesetVersion];
  if (!rules) throw new Error(`unknown match ruleset ${row.rulesetVersion}`);
  return rules;
}

function competitionError(error: unknown): never {
  if (error instanceof CompetitionError) {
    switch (error.code) {
      case "VALIDATION_ERROR":
        throw new AppError("VALIDATION_ERROR", error.message);
      case "SAME_ACCOUNT":
      case "PARTICIPANT_KIND_MISMATCH":
      case "RATINGS_FORBIDDEN":
        throw new AppError("FORBIDDEN", error.message, { reason: error.code });
      default:
        throw new AppError("REVISION_CONFLICT", error.message, { reason: error.code });
    }
  }
  throw error;
}

function reduce(state: MatchState, command: MatchCommand): ReturnType<typeof reduceMatch> {
  try {
    return reduceMatch(state, command);
  } catch (error) {
    return competitionError(error);
  }
}

function botParticipant(config: BotConfig): Participant {
  return { kind: "bot", strategy: config.strategy, botVersion: BOT_VERSION };
}

/**
 * Duel matches (DUEL-01..06, DB-07, OPS-08). All match rules come from @g2048/competition reducers.
 *
 * Every command is ONE writer transaction. Seat moves/forfeits go through GameService's internal
 * `*InTransaction` API with `owner: null` + duel modes only, AFTER this service checked that the
 * session account owns that seat (bot seats are driven only by the server). When a seat game ends,
 * GameService's onTerminal hook runs inside the same transaction and this service marks the seat
 * terminal, and when both seats are terminal finalizes the match: outcome (decideDuel via reduceMatch),
 * elo-v1 rating_events (UNIQUE match+user) and ratings rows. So the final move, the seat end, the
 * finish and the Elo update commit atomically or not at all. Match WebSocket events (match.updated,
 * match.seat-ended, match.finished, rating.updated) go through EventBus.publishAfterCommit with a
 * per-match sequence stored in matches.sequence.
 */
export class MatchService {
  /** Called after a commit that may give bot seats work (wired to the bot driver). */
  onBotWork: (matchId: string) => void = () => undefined;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly games: GameService,
    private readonly events: EventBus,
    readonly eventLog: MatchEventLog,
  ) {
    games.onTerminal((db, record, finalState, reason) => {
      if (!DUEL_MODES.includes(record.mode)) return;
      const seat = matchesRepo.findSeatByGame(db, record.id);
      if (seat) this.endSeat(db, seat.matchId, seat.seat, finalState, reason);
    });
  }

  // ---------- commands ----------

  async create(userId: string, body: CreateMatchBody): Promise<MatchDetail> {
    const detail = await this.ctx.writer.run((db) => {
      const now = nowIso(this.ctx);
      const id = randomUUID();
      const rules = RULESETS["duel-v1"];
      const seasonId = body.kind === "human-human" ? this.activeSeason(db, rules.version) : null;
      const creator: Participant =
        body.kind === "bot-bot" ? botParticipant(body.bots[0]) : { kind: "human", accountId: userId };
      let state = this.created(id, body.kind, seasonId, rules, creator);
      const seed = (body.kind === "bot-bot" ? body.seed : undefined) ?? randomUUID();
      matchesRepo.insertMatch(db, {
        id,
        kind: body.kind,
        seasonId,
        rulesetVersion: rules.version,
        seed,
        status: "lobby",
        sequence: 0,
        createdByUserId: userId,
        createdAt: now,
      });
      if (body.kind === "human-human") {
        matchesRepo.insertSeat(db, { matchId: id, seat: "a", userId, bot: null, gameId: null, now });
        return this.detail(db, this.load(db, id));
      }
      const second = body.kind === "human-bot" ? body.bot : body.bots[1];
      state = reduce(state, { type: "join", participant: botParticipant(second) }).state;
      const mode: GameMode = body.kind === "human-bot" ? "duel-bot" : "bot-vs-bot";
      const humanOwner = body.kind === "human-bot" ? { userId } : null;
      const gameA = this.games.createInTransaction(db, humanOwner, { mode, rules, seed });
      const gameB = this.games.createInTransaction(db, null, { mode, rules, seed });
      matchesRepo.insertSeat(db, {
        matchId: id,
        seat: "a",
        userId: body.kind === "human-bot" ? userId : null,
        bot:
          body.kind === "bot-bot"
            ? { strategy: body.bots[0].strategy, version: BOT_VERSION, config: body.bots[0] }
            : null,
        gameId: gameA.id,
        now,
      });
      matchesRepo.insertSeat(db, {
        matchId: id,
        seat: "b",
        userId: null,
        bot: { strategy: second.strategy, version: BOT_VERSION, config: second },
        gameId: gameB.id,
        now,
      });
      matchesRepo.setStatus(db, id, state.status, null, now);
      return this.publishMatchUpdated(db, id);
    });
    if (body.kind !== "human-human") this.onBotWork(detail.id);
    return detail;
  }

  async join(userId: string, matchId: string): Promise<MatchDetail> {
    return this.ctx.writer.run((db) => {
      const bundle = this.loadVisible(db, matchId, userId);
      if (bundle.row.kind !== "human-human") {
        throw new AppError("REVISION_CONFLICT", "This match does not take a second player", {
          reason: "INVALID_TRANSITION",
        });
      }
      const now = nowIso(this.ctx);
      const rules = rulesFor(bundle.row);
      const next = reduce(this.toState(bundle), {
        type: "join",
        participant: { kind: "human", accountId: userId },
      }).state;
      const creator = bundle.seats.a?.userId;
      if (!creator) throw new Error("lobby without creator seat");
      const spec = { mode: "duel-human" as const, rules, seed: bundle.row.seed };
      const gameA = this.games.createInTransaction(db, { userId: creator }, spec);
      const gameB = this.games.createInTransaction(db, { userId }, spec);
      matchesRepo.setSeatGame(db, matchId, "a", gameA.id);
      matchesRepo.insertSeat(db, { matchId, seat: "b", userId, bot: null, gameId: gameB.id, now });
      matchesRepo.setStatus(db, matchId, next.status, null, now);
      return this.publishMatchUpdated(db, matchId);
    });
  }

  /** A human seat move. The session account must own `seat` (hot-seat: re-login switches accounts). */
  async move(
    userId: string,
    matchId: string,
    seat: SeatId,
    command: { commandId: string; expectedRevision: number; direction: Direction },
  ): Promise<MoveResponse> {
    return this.ctx.writer.run((db) => {
      const bundle = this.loadVisible(db, matchId, userId);
      this.requireOwnSeat(bundle, seat, userId);
      return this.seatMove(db, bundle, seat, command);
    });
  }

  async forfeit(
    userId: string,
    matchId: string,
    seat: SeatId,
    command: { commandId: string; expectedRevision: number },
  ): Promise<MatchDetail> {
    return this.ctx.writer.run((db) => {
      const bundle = this.loadVisible(db, matchId, userId);
      this.requireOwnSeat(bundle, seat, userId);
      const now = nowIso(this.ctx);
      if (bundle.row.status === "lobby") {
        // The creator leaving an unjoined lobby abandons it (no game was ever played).
        const next = reduce(this.toState(bundle), { type: "abandon-lobby" }).state;
        matchesRepo.setStatus(db, matchId, next.status, null, now);
        return this.publishMatchUpdated(db, matchId);
      }
      const gameId = this.seatGameId(bundle, seat);
      const before = bundle.games[seat]?.state.revision ?? 0;
      const response = this.games.forfeitInTransaction(db, gameId, command, SEAT_ACCESS);
      if (response.state.revision > before) return this.publishMatchUpdated(db, matchId);
      return this.detail(db, this.load(db, matchId));
    });
  }

  /** Bot seats use the same command path as humans; only the server's bot driver calls this. */
  async botMove(
    matchId: string,
    seat: SeatId,
    command: { commandId: string; expectedRevision: number; direction: Direction },
  ): Promise<MoveResponse> {
    return this.ctx.writer.run((db) => {
      const bundle = this.load(db, matchId);
      if (!bundle.seats[seat]?.botStrategy) throw new AppError("FORBIDDEN", "Not a bot seat");
      return this.seatMove(db, bundle, seat, command);
    });
  }

  /**
   * Restart/consistency recovery: ends seats whose game already ended and finalizes a match whose
   * seats are all terminal. Idempotent; never rates twice (seat end and finish are guarded).
   */
  async reconcile(matchId: string): Promise<void> {
    await this.ctx.writer.run((db) => {
      const bundle = this.load(db, matchId);
      if (bundle.row.status !== "active") return;
      for (const seat of ["a", "b"] as const) {
        const game = bundle.games[seat];
        if (bundle.seats[seat]?.terminalReason === null && game && game.state.status !== "active") {
          this.endSeat(db, matchId, seat, game.state, this.reasonOf(bundle.row, game.state));
        }
      }
      const fresh = this.load(db, matchId);
      if (fresh.row.status === "active" && fresh.seats.a?.terminalReason && fresh.seats.b?.terminalReason) {
        this.finish(db, fresh, this.toState(fresh), nowIso(this.ctx));
      }
    });
  }

  // ---------- reads ----------

  get(userId: string, matchId: string): MatchDetail {
    return this.detail(this.ctx.db, this.loadVisible(this.ctx.db, matchId, userId));
  }

  list(userId: string, limit = 50): MatchDetail[] {
    const db = this.ctx.db;
    return matchesRepo.listVisible(db, userId, limit).map((row) => this.detail(db, this.load(db, row.id)));
  }

  activeMatchIds(): string[] {
    return matchesRepo.activeIds(this.ctx.db);
  }

  /** Everything a bot seat needs to decide, or null when the seat is not a bot seat. */
  botSnapshot(matchId: string, seat: SeatId): BotSeatSnapshot | null {
    const db = this.ctx.db;
    const bundle = UUID.test(matchId) ? this.loadOrNull(db, matchId) : null;
    const seatRow = bundle?.seats[seat];
    const game = bundle?.games[seat];
    if (!bundle || !seatRow?.botConfig || !game) return null;
    return {
      match: this.toState(bundle),
      game: game.state,
      gameId: game.id,
      rules: rulesFor(bundle.row),
      config: seatRow.botConfig,
      // Bot-specific stream per (match seed, seat, move): never the game's PRNG; re-derived after a
      // restart, so no rng column is needed.
      botRng: deriveBotRng(engineAdapter, `${bundle.row.seed}#${seat}#${game.state.acceptedMoves}`),
    };
  }

  /**
   * WebSocket authorization: a match is watchable by its seat accounts, and a bot-bot match also by
   * the account that created it (it has no human seats; documented in the README).
   */
  canWatchMatch(userId: string, matchId: string): boolean {
    const bundle = UUID.test(matchId) ? this.loadOrNull(this.ctx.db, matchId) : null;
    if (!bundle) return false;
    if (bundle.seats.a?.userId === userId || bundle.seats.b?.userId === userId) return true;
    return bundle.row.kind === "bot-bot" && bundle.row.createdByUserId === userId;
  }

  // ---------- internals (all inside a writer transaction unless noted) ----------

  private seatMove(
    db: DatabaseSync,
    bundle: Bundle,
    seat: SeatId,
    command: { commandId: string; expectedRevision: number; direction: Direction },
  ): MoveResponse {
    const gameId = this.seatGameId(bundle, seat);
    const before = bundle.games[seat]?.state.revision ?? 0;
    // No match-status gate: an ended seat refuses new moves in GameService (403), while an
    // idempotent replay still returns its stored response after the match finished.
    const response = this.games.moveInTransaction(db, gameId, command, SEAT_ACCESS);
    if (response.changed && response.state.revision > before) {
      this.publishMatchUpdated(db, bundle.row.id);
    }
    return { ...response, state: redact(response.state) as GameState };
  }

  /** onTerminal (same transaction as the ending move/forfeit): seat terminal exactly once, maybe finish. */
  private endSeat(
    db: DatabaseSync,
    matchId: string,
    seat: SeatId,
    finalState: GameState,
    reason: SeatTerminalReason,
  ): void {
    const bundle = this.load(db, matchId);
    if (bundle.row.status !== "active" || bundle.seats[seat]?.terminalReason) return;
    const now = nowIso(this.ctx);
    const max = maxExponent(finalState.board);
    const base = this.toState(bundle);
    const state: MatchState = {
      ...base,
      seats: {
        ...base.seats,
        [seat]: {
          ...base.seats[seat],
          score: finalState.score,
          maxExponent: max,
          acceptedMoves: finalState.acceptedMoves,
        },
      },
    };
    const reduced = reduce(state, {
      type: "seat-terminal",
      seat,
      reason,
      score: finalState.score,
      maxExponent: max,
      acceptedMoves: finalState.acceptedMoves,
    });
    if (!matchesRepo.endSeat(db, matchId, seat, reason, now)) return;
    this.appendEvent(db, matchId, "match.seat-ended", {
      seat,
      terminal: reason,
      score: finalState.score,
      maxExponent: max,
      acceptedMoves: finalState.acceptedMoves,
    });
    const ended = reduced.events.find((e) => e.type === "seat.ended");
    if (ended?.type === "seat.ended" && ended.readyToFinish) this.finish(db, bundle, reduced.state, now);
  }

  /**
   * Finish exactly once: decideDuel via reduceMatch; human-human applies elo-v1 through the season
   * ladder (applyRatingEvent) and inserts rating_events (UNIQUE match+user) + ratings in this tx.
   * human-bot / bot-bot finish without ratings (they never touch human Elo).
   */
  private finish(db: DatabaseSync, bundle: Bundle, state: MatchState, now: string): void {
    const matchId = bundle.row.id;
    let ratingEvents: readonly RatingEvent[] = [];
    let finished: MatchState;
    if (bundle.row.kind === "human-human") {
      const seasonId = bundle.row.seasonId;
      const a = bundle.seats.a?.userId;
      const b = bundle.seats.b?.userId;
      if (!seasonId || !a || !b) throw new Error("rated match without season or players");
      const ruleset = bundle.row.rulesetVersion;
      let ladder = this.ladder(db, seasonId, ruleset, [a, b]);
      finished = reduce(state, {
        type: "finish",
        ratings: {
          a: getRatingRecord(ladder, a, ruleset).rating,
          b: getRatingRecord(ladder, b, ruleset).rating,
        },
      }).state;
      ratingEvents = finished.ratingEvents;
      for (const e of ratingEvents) {
        const applied = applyRatingEvent(ladder, e);
        if (!applied.applied) throw new Error("duplicate rating event in one finish");
        ladder = applied.state;
        matchesRepo.insertRatingEvent(db, {
          matchId,
          userId: e.accountId,
          seasonId,
          rulesetVersion: e.rulesetVersion,
          before: e.before,
          after: e.after,
          delta: e.delta,
          outcome: e.outcome === 1 ? "1" : e.outcome === 0 ? "0" : "0.5",
          algorithm: e.algorithm,
          idempotencyKey: e.idempotencyKey,
          createdAt: now,
        });
        const record = getRatingRecord(ladder, e.accountId, e.rulesetVersion, seasonId);
        matchesRepo.upsertRating(
          db,
          {
            userId: record.accountId,
            seasonId,
            rulesetVersion: record.rulesetVersion,
            rating: record.rating,
            played: record.played,
            won: record.won,
            drawn: record.drawn,
            lost: record.lost,
          },
          now,
        );
      }
    } else {
      finished = reduce(state, { type: "finish" }).state;
    }
    matchesRepo.setStatus(db, matchId, "finished", finished.outcome, now);
    this.appendEvent(db, matchId, "match.finished", { outcome: finished.outcome });
    for (const e of ratingEvents) {
      this.appendEvent(db, matchId, "rating.updated", {
        accountId: e.accountId,
        season: e.season,
        rulesetVersion: e.rulesetVersion,
        before: e.before,
        after: e.after,
        delta: e.delta,
        outcome: e.outcome,
      });
    }
  }

  /** Season ladder slice for the given players, from the ratings table (absent = 1000). */
  private ladder(db: DatabaseSync, seasonId: string, rulesetVersion: string, users: string[]): SeasonsState {
    const ratings: Record<string, RatingRecord> = {};
    for (const userId of users) {
      const row = matchesRepo.rating(db, userId, seasonId, rulesetVersion);
      ratings[ratingKey(userId, seasonId, rulesetVersion)] = {
        accountId: userId,
        season: seasonId,
        rulesetVersion,
        rating: row?.rating ?? ELO.initialRating,
        played: row?.played ?? 0,
        won: row?.won ?? 0,
        drawn: row?.drawn ?? 0,
        lost: row?.lost ?? 0,
      };
    }
    return {
      activeSeason: seasonId,
      order: [seasonId],
      ladders: { [seasonId]: { season: seasonId, status: "active", ratings, appliedEventKeys: {} } },
    };
  }

  /** Seasons are seeded by backend at startup (CONTRACT-001 C18); never created here. */
  private activeSeason(db: DatabaseSync, rulesetVersion: string): string {
    const id = competitionRepo.activeSeason(db, rulesetVersion)?.id;
    if (!id) {
      throw new AppError("DB_BUSY", `No active ${rulesetVersion} season yet; retry shortly`, {
        reason: "NO_ACTIVE_SEASON",
      });
    }
    return id;
  }

  /**
   * Next per-match sequence: matches.sequence and the match_events row (migration 4) are written in
   * the same transaction (invariant: matches.sequence = MAX(match_events.sequence)); the WebSocket
   * delivery happens only after COMMIT.
   */
  private appendEvent(db: DatabaseSync, matchId: string, type: WsEventType, payload: unknown): number {
    const now = nowIso(this.ctx);
    const sequence = matchesRepo.bumpSequence(db, matchId, now);
    this.eventLog.append(db, matchId, { sequence, type, payload }, now);
    this.events.publishAfterCommit({ type, resourceId: matchId, sequence, payload });
    return sequence;
  }

  private publishMatchUpdated(db: DatabaseSync, matchId: string): MatchDetail {
    const sequence = matchesRepo.get(db, matchId)?.sequence ?? 0;
    const detail = { ...this.detail(db, this.load(db, matchId)), sequence: sequence + 1 };
    this.appendEvent(db, matchId, "match.updated", { match: detail });
    return detail;
  }

  private reasonOf(row: MatchRow, state: GameState): SeatTerminalReason {
    if (state.status === "forfeited") return "forfeit";
    const cap = rulesFor(row).moveCap;
    return cap !== null && state.acceptedMoves >= cap ? "move-cap" : "dead-board";
  }

  private created(
    id: string,
    kind: CreateMatchBody["kind"],
    seasonId: string | null,
    rules: Ruleset,
    creator: Participant,
  ): MatchState {
    try {
      return createMatch({
        id,
        kind,
        season: seasonId ?? UNRATED,
        rulesetVersion: rules.version,
        moveCap: rules.moveCap ?? 500,
        creator,
      }).state;
    } catch (error) {
      return competitionError(error);
    }
  }

  private requireOwnSeat(bundle: Bundle, seat: SeatId, userId: string): void {
    if (bundle.seats[seat]?.userId !== userId) throw new AppError("FORBIDDEN", "That is not your seat");
  }

  private seatGameId(bundle: Bundle, seat: SeatId): string {
    const gameId = bundle.seats[seat]?.gameId;
    if (!gameId) {
      throw new AppError("REVISION_CONFLICT", "The match has not started", { reason: "INVALID_TRANSITION" });
    }
    return gameId;
  }

  private loadOrNull(db: DatabaseSync, matchId: string): Bundle | null {
    const row = matchesRepo.get(db, matchId);
    if (!row) return null;
    const seats: Record<SeatId, SeatRow | null> = { a: null, b: null };
    for (const s of matchesRepo.seats(db, matchId)) seats[s.seat] = s;
    const games: Record<SeatId, GameRecord | null> = { a: null, b: null };
    for (const seat of ["a", "b"] as const) {
      const gameId = seats[seat]?.gameId;
      games[seat] = gameId ? gamesRepo.get(db, gameId) : null;
    }
    return { row, seats, games };
  }

  private load(db: DatabaseSync, matchId: string): Bundle {
    const bundle = this.loadOrNull(db, matchId);
    if (!bundle) throw new AppError("NOT_FOUND", "Match not found");
    return bundle;
  }

  /** Seat accounts and the creator see a match; any account sees an open human-human lobby. */
  private loadVisible(db: DatabaseSync, matchId: string, userId: string): Bundle {
    if (!UUID.test(matchId)) throw new AppError("NOT_FOUND", "Match not found");
    const bundle = this.load(db, matchId);
    const openLobby = bundle.row.status === "lobby" && bundle.row.kind === "human-human";
    const member =
      bundle.row.createdByUserId === userId ||
      bundle.seats.a?.userId === userId ||
      bundle.seats.b?.userId === userId;
    if (!openLobby && !member) throw new AppError("NOT_FOUND", "Match not found");
    return bundle;
  }

  private toState(bundle: Bundle): MatchState {
    const rules = rulesFor(bundle.row);
    const seat = (id: SeatId): MatchState["seats"]["a"] => {
      const row = bundle.seats[id];
      const game = bundle.games[id];
      const participant: Participant | null = row
        ? row.userId
          ? { kind: "human", accountId: row.userId }
          : {
              kind: "bot",
              strategy: row.botStrategy as NonNullable<SeatRow["botStrategy"]>,
              botVersion: row.botVersion ?? BOT_VERSION,
            }
        : null;
      return {
        participant,
        score: game?.state.score ?? "0",
        maxExponent: game ? maxExponent(game.state.board) : null,
        acceptedMoves: game?.state.acceptedMoves ?? 0,
        terminal: row?.terminalReason ?? null,
      };
    };
    return {
      id: bundle.row.id,
      kind: bundle.row.kind,
      season: bundle.row.seasonId ?? UNRATED,
      rulesetVersion: bundle.row.rulesetVersion,
      moveCap: rules.moveCap ?? 500,
      status: bundle.row.status,
      seats: { a: seat("a"), b: seat("b") },
      outcome: bundle.row.outcome,
      ratingEvents: [],
      sequence: bundle.row.sequence,
    };
  }

  private detail(db: DatabaseSync, bundle: Bundle): MatchDetail {
    const seatView = (id: SeatId): SeatView | null => {
      const row = bundle.seats[id];
      if (!row) return null;
      const game = bundle.games[id];
      const strategy = row.botStrategy;
      return {
        seat: id,
        kind: row.userId ? "human" : "bot",
        displayName: row.userId
          ? matchesRepo.displayName(db, row.userId)
          : `${strategy ?? "bot"} (${strategy ? BOT_DIFFICULTY[strategy] : "bot"})`,
        accountId: row.userId,
        botStrategy: strategy,
        gameId: row.gameId,
        score: game?.state.score ?? "0",
        maxExponent: game ? maxExponent(game.state.board) : null,
        acceptedMoves: game?.state.acceptedMoves ?? 0,
        terminal: row.terminalReason,
      };
    };
    const seats = (["a", "b"] as const).map(seatView).filter((s): s is SeatView => s !== null);
    return {
      id: bundle.row.id,
      kind: bundle.row.kind,
      status: bundle.row.status,
      rulesetVersion: bundle.row.rulesetVersion,
      season: bundle.row.seasonId ?? UNRATED,
      seats,
      outcome: bundle.row.outcome,
      ratingChanges: matchesRepo.ratingEvents(db, bundle.row.id).map((e) => ({
        accountId: e.userId,
        before: e.before,
        after: e.after,
        delta: e.delta,
      })),
      sequence: bundle.row.sequence,
      seed: bundle.row.kind === "bot-bot" ? bundle.row.seed : null,
      seatStates: {
        a: bundle.games.a ? redact(bundle.games.a.state) : null,
        b: bundle.games.b ? redact(bundle.games.b.state) : null,
      },
    };
  }
}
