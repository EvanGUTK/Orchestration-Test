import { randomBytes, randomUUID } from "node:crypto";
import * as engine from "@2048/engine";
import { describeBot, validateBotConfig } from "@2048/bots";
import {
  boardMaxExponent, canRate, initialRating, ratingEventsFor, reduceMatch, type MatchEvent, type MatchState, type SeatSlot,
} from "@2048/competition";
import { BOT_VERSION, DUEL_RULES, DomainError, type BotConfig, type CreateMatchRequest, type MatchView, type Page, type SeatView } from "@2048/contracts";
import { createRepos, type GameDb, type MatchRow, type WriteQueue } from "@2048/database";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { forbidden, notFound, validation } from "../errors.ts";
import type { Principal } from "./accounts.ts";
import type { BotRunManager } from "./bots.ts";
import { createGameRecord, type ChangeContext, type GameService } from "./games.ts";
import type { Publisher } from "./outbox.ts";
import type { SeasonService } from "./seasons.ts";

const MAX_OPEN_LOBBIES = 5;

function cursorOf(m: { createdAt: string; id: string }): string {
  return Buffer.from(`${m.createdAt}|${m.id}`, "utf8").toString("base64url");
}
function parseCursor(raw: string): { createdAt: string; id: string } {
  const [createdAt, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (extra !== undefined || !createdAt || !id || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(createdAt)) throw validation("Invalid cursor");
  return { createdAt, id };
}

export type MatchServiceDeps = {
  db: GameDb;
  queue: WriteQueue;
  seasons: SeasonService;
  games: GameService;
  bots: BotRunManager;
  publish?: Publisher;
  now?: () => Date;
};

type Raw = SqliteDatabase;

export class MatchService {
  readonly #d: MatchServiceDeps;

  constructor(deps: MatchServiceDeps) {
    this.#d = deps;
  }

  #now(): string {
    return (this.#d.now?.() ?? new Date()).toISOString();
  }

  // ---- state / view -------------------------------------------------------------------------------------------

  /** Rebuild the pure MatchState from authoritative rows. */
  #state(raw: Raw, m: MatchRow): MatchState {
    const repos = createRepos(raw);
    const seats = repos.competition.seats(m.id);
    const slot = (seat: 0 | 1): SeatSlot | null => {
      const row = seats.find((s) => s.seat === seat);
      if (!row) return null;
      const g = row.gameId ? repos.games.get(row.gameId) : undefined;
      const isBot = row.accountId === null;
      return {
        seat,
        kind: isBot ? "bot" : "human",
        accountId: row.accountId,
        botLabel: isBot && row.botConfigJson ? describeBot(JSON.parse(row.botConfigJson) as BotConfig).label : null,
        gameId: row.gameId,
        acceptedMoves: g?.state.acceptedMoves ?? 0,
        game: { terminalReason: row.terminalReason, score: g?.state.score ?? "0", maxExponent: g ? boardMaxExponent(g.state.board) : "0" },
      };
    };
    const s0 = slot(0);
    if (!s0) throw new DomainError("INTERNAL_ERROR", "Match has no seat 0", { matchId: m.id });
    return {
      id: m.id, kind: m.kind, seasonId: m.seasonId, rulesetVersion: m.rulesetVersion, status: m.status, seats: [s0, slot(1)],
      outcome: m.outcome, decidedBy: null, ratable: m.kind === "human-vs-human",
      rated: repos.competition.ratingEvents(m.id).length > 0,
    };
  }

  view(raw: Raw, matchId: string): MatchView {
    const repos = createRepos(raw);
    const m = repos.competition.match(matchId);
    if (!m) throw notFound("Match not found");
    const seats = repos.competition.seats(m.id);
    const seatView = (seat: 0 | 1): SeatView | null => {
      const row = seats.find((s) => s.seat === seat);
      if (!row) return null;
      const g = row.gameId ? repos.games.get(row.gameId) : undefined;
      const isBot = row.accountId === null;
      const displayName = isBot
        ? describeBot(JSON.parse(row.botConfigJson ?? "{}") as BotConfig).label
        : (repos.accounts.userById(row.accountId!)?.displayName ?? "Deleted player");
      return {
        seat, kind: isBot ? "bot" : "human", displayName, gameId: row.gameId, terminalReason: row.terminalReason,
        ...(g ? { score: g.state.score, maxExponent: boardMaxExponent(g.state.board), acceptedMoves: g.state.acceptedMoves } : {}),
      };
    };
    return {
      id: m.id, kind: m.kind, status: m.status, outcome: m.outcome, seasonId: m.seasonId, rulesetVersion: m.rulesetVersion,
      seats: [seatView(0)!, seatView(1)], ratingEvents: repos.competition.ratingEvents(m.id),
    };
  }

  /** A human seat, or the account that created a bot-vs-bot match (it has no seat but may watch and steer it). */
  #isSeat(raw: Raw, matchId: string, accountId: string): boolean {
    const c = createRepos(raw).competition;
    return c.seats(matchId).some((s) => s.accountId === accountId) || c.match(matchId)?.createdBy === accountId;
  }

  // ---- API ----------------------------------------------------------------------------------------------------

  async create(principal: Principal, req: CreateMatchRequest): Promise<MatchView> {
    if (principal.kind !== "user") throw forbidden("Matches require an account");
    let bots: BotConfig[] = [];
    try {
      if (req.kind === "human-vs-human") {
        if (req.bot || req.opponentBot) throw validation("Human matches take no bot configuration");
      } else if (req.kind === "human-vs-bot") {
        if (!req.bot || req.opponentBot) throw validation("human-vs-bot requires exactly `bot`");
        bots = [validateBotConfig(req.bot)];
      } else if (req.kind === "bot-vs-bot") {
        if (!req.bot || !req.opponentBot) throw validation("bot-vs-bot requires `bot` and `opponentBot`");
        bots = [validateBotConfig(req.bot), validateBotConfig(req.opponentBot)];
      } else {
        throw validation("Unknown match kind");
      }
    } catch (err) {
      if (err instanceof DomainError && err.code === "VALIDATION_ERROR") throw err;
      throw validation(err instanceof Error ? err.message : "Invalid bot configuration");
    }
    const season = await this.#d.seasons.current();
    const at = this.#now();
    const seed = randomBytes(16).toString("hex");
    const id = randomUUID();
    const runIds: string[] = [];
    const view = await this.#d.queue.submit((raw) => {
      const repos = createRepos(raw);
      const c = repos.competition;
      if (req.kind === "human-vs-human") {
        const open = c.listMatches({ accountId: principal.userId, status: "lobby", limit: MAX_OPEN_LOBBIES + 1 });
        if (open.length >= MAX_OPEN_LOBBIES) throw new DomainError("RESOURCE_LIMIT", "Too many open lobbies; close one first");
      }
      c.insertMatch({
        id, seasonId: season.id, rulesetVersion: DUEL_RULES.version, kind: req.kind, seed,
        status: req.kind === "human-vs-human" ? "lobby" : "active", createdBy: principal.userId, createdAt: at,
      });
      if (req.kind === "human-vs-human") {
        c.insertSeat({ matchId: id, seat: 0, accountId: principal.userId, botConfigJson: null, gameId: null });
      } else {
        let seat = 0 as 0 | 1;
        if (req.kind === "human-vs-bot") {
          const g = createGameRecord(raw, { owner: { userId: principal.userId }, mode: "duel", rules: DUEL_RULES, seed, at, matchId: id, seat: 0 });
          c.insertSeat({ matchId: id, seat: 0, accountId: principal.userId, botConfigJson: null, gameId: g.id });
          seat = 1;
        }
        for (const cfg of bots) {
          const label = describeBot(cfg).label;
          const g = createGameRecord(raw, { owner: null, mode: "bot-duel", rules: DUEL_RULES, seed, at, matchId: id, seat, botLabel: label });
          c.insertSeat({ matchId: id, seat, accountId: null, botConfigJson: JSON.stringify(cfg), gameId: g.id });
          const runId = randomUUID();
          repos.bots.insert({
            id: runId, ownerUserId: principal.userId, ownerGuestId: null, botVersion: BOT_VERSION, mode: "league", configJson: JSON.stringify(cfg),
            budgetJson: JSON.stringify({ nodeBudget: cfg.nodeBudget, timeBudgetMs: cfg.timeBudgetMs, maxMoves: DUEL_RULES.moveCap }),
            status: "running", gameId: g.id, matchId: id, gameSeed: seed, rulesetVersion: DUEL_RULES.version, maxMoves: DUEL_RULES.moveCap, paceMs: 0, at,
          });
          runIds.push(runId);
          seat = 1;
        }
      }
      return this.view(raw, id);
    });
    for (const runId of runIds) this.#d.bots.launch(runId);
    return view;
  }

  async join(principal: Principal, matchId: string): Promise<MatchView> {
    if (principal.kind !== "user") throw forbidden("Matches require an account");
    const at = this.#now();
    return this.#d.queue.submit((raw) => {
      const repos = createRepos(raw);
      const c = repos.competition;
      const m = c.match(matchId);
      if (!m) throw notFound("Match not found");
      const state = this.#state(raw, m);
      reduceMatch(state, { type: "join", accountId: principal.userId }); // throws FORBIDDEN for own match / no free seat / not a lobby
      const host = state.seats[0].accountId!;
      const rules = DUEL_RULES;
      const g0 = createGameRecord(raw, { owner: { userId: host }, mode: "duel", rules, seed: m.seed, at, matchId: m.id, seat: 0 });
      const g1 = createGameRecord(raw, { owner: { userId: principal.userId }, mode: "duel", rules, seed: m.seed, at, matchId: m.id, seat: 1 });
      c.setSeatGame(m.id, 0, g0.id);
      c.insertSeat({ matchId: m.id, seat: 1, accountId: principal.userId, botConfigJson: null, gameId: g1.id });
      c.updateMatch(m.id, "active", null, null);
      return this.view(raw, m.id);
    });
  }

  get(principal: Principal, matchId: string): MatchView {
    return this.#d.db.read((raw) => {
      const m = createRepos(raw).competition.match(matchId);
      if (!m) throw notFound("Match not found");
      const visible = m.status === "lobby" ? principal.kind === "user" : principal.kind === "user" && this.#isSeat(raw, m.id, principal.userId);
      if (!visible) throw notFound("Match not found");
      return this.view(raw, m.id);
    });
  }

  canRead(accountId: string, matchId: string): boolean {
    return this.#d.db.read((raw) => {
      const m = createRepos(raw).competition.match(matchId);
      return !!m && this.#isSeat(raw, m.id, accountId);
    });
  }

  list(principal: Principal, q: { scope: "mine" | "lobby"; status?: "lobby" | "active" | "finished" | undefined; cursor?: string | undefined; limit: number }): Page<MatchView> {
    if (principal.kind !== "user") return { items: [], nextCursor: null };
    return this.#d.db.read((raw) => {
      const c = createRepos(raw).competition;
      const rows = c.listMatches({
        ...(q.scope === "mine" ? { accountId: principal.userId } : { lobbyOnly: true }),
        ...(q.status ? { status: q.status } : {}),
        ...(q.cursor ? { after: parseCursor(q.cursor) } : {}),
        limit: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map((m) => this.view(raw, m.id)), nextCursor: rows.length > q.limit && last ? cursorOf(last) : null };
    });
  }

  // ---- reaction to seat game changes (runs inside the game command transaction) -----------------------------

  afterChange(ctx: ChangeContext): void {
    const { raw, game, next, at, outbox } = ctx;
    if (!game.matchId || game.seat === null) return;
    const repos = createRepos(raw);
    const c = repos.competition;
    const m = c.match(game.matchId);
    if (!m || m.status !== "active") return;
    const state = this.#state(raw, m);
    const seat = game.seat;

    let event: MatchEvent | null = null;
    if (next.status === "forfeited") {
      event = { type: "forfeit", seat };
    } else if (next.status === "completed") {
      const dead = engine.isGameOver(next.board);
      event = {
        type: "seat-ended", seat, reason: dead ? "dead" : "move-cap",
        score: next.score, maxExponent: boardMaxExponent(next.board), acceptedMoves: next.acceptedMoves,
      };
    }
    if (!event) return; // ordinary progress: the game.updated event already carries it
    const before = state.seats[seat]!.game.terminalReason;
    const after = reduceMatch(state, event);
    const reason = after.seats[seat]!.game.terminalReason;
    if (reason === null || reason === before) return;
    c.setSeatTerminal(m.id, seat, reason);

    const accounts = after.seats.flatMap((s) => (s?.accountId ? [s.accountId] : []));
    // 1) the seat ended
    c.bumpMatch(m.id);
    outbox.push("match.seat-ended", m.id, c.match(m.id)!.sequence, { match: this.view(raw, m.id) }, accounts);

    // 2) possibly the match finished (+ exactly-once rating)
    if (after.status === "finished" && after.outcome) {
      c.updateMatch(m.id, "finished", after.outcome, at);
      const finishedState: MatchState = { ...after, rated: state.rated };
      const season = c.season(m.seasonId);
      if (canRate(finishedState) && season?.status === "active") {
        const [a, b] = [finishedState.seats[0].accountId!, finishedState.seats[1]!.accountId!];
        c.ensureRating(a, m.seasonId, m.rulesetVersion, initialRating());
        c.ensureRating(b, m.seasonId, m.rulesetVersion, initialRating());
        const ra = c.rating(a, m.seasonId, m.rulesetVersion)!.rating;
        const rb = c.rating(b, m.seasonId, m.rulesetVersion)!.rating;
        const events = ratingEventsFor(finishedState, { seat0: ra, seat1: rb });
        if (events) {
          for (const e of events) {
            const rowId = c.applyRatingEvent(e, at);
            if (rowId > 0) outbox.push("rating.updated", e.accountId, rowId, { event: e }, [e.accountId]);
          }
        }
      }
      outbox.push("match.finished", m.id, c.match(m.id)!.sequence, { match: this.view(raw, m.id) }, accounts);
    }
  }
}
