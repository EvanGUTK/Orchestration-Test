import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import * as engine from "@2048/engine";
import { createRepos, type GameDb, type StoredGame, type WriteQueue } from "@2048/database";
import {
  CLASSIC_RULES, DomainError, SNAPSHOT_INTERVAL, customRules, resolveRules,
  type Direction, type EventsPage, type GameMode, type GameState, type GameView, type MoveResponse, type Page, type Ruleset,
} from "@2048/contracts";
import type { ServerConfig } from "../config.ts";
import { forbidden, notFound, validation } from "../errors.ts";
import type { Principal } from "./accounts.ts";
import { Outbox, type Publisher } from "./outbox.ts";

export type Owner = { userId: string } | { guestId: string };
export const ownerOf = (p: Principal): Owner => (p.kind === "user" ? { userId: p.userId } : { guestId: p.userId });

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const rulesDigest = (r: Ruleset) => sha256(JSON.stringify(r));

export type MoveKind = "move" | "undo" | "forfeit" | "end";

/** Called inside the command transaction after a CHANGED transition was persisted (never for no-ops). */
export type ChangeContext = {
  raw: SqliteDatabase;
  game: StoredGame; // state before the change
  next: GameState;
  kind: MoveKind;
  at: string;
  outbox: Outbox;
};
export type GameHooks = { afterChange(ctx: ChangeContext): void };

export type CreateGameInput = {
  mode: "classic" | "practice" | "bot-exhibition";
  custom?: { boardSize?: number | undefined; seed?: string | undefined; spawnFourTenths?: number | undefined } | undefined;
};

export type GameServiceDeps = { db: GameDb; queue: WriteQueue; config: ServerConfig; now?: () => Date; publish?: Publisher };

/** Everything needed to persist a brand-new game inside an existing transaction. */
export type NewGameRecord = {
  owner: { userId: string } | { guestId: string } | null;
  mode: GameMode;
  rules: Ruleset;
  seed: string;
  at: string;
  challengeId?: string | null;
  matchId?: string | null;
  seat?: 0 | 1 | null;
  botLabel?: string | null;
};

/** Insert game + ruleset + revision-0 snapshot. Used by solo creation, ranked attempts, duels and bot runs. */
export function createGameRecord(raw: SqliteDatabase, n: NewGameRecord): StoredGame {
  const r = createRepos(raw).games;
  const state = engine.newGame(n.rules, n.seed);
  const id = randomUUID();
  r.ensureRuleset(n.rules, rulesDigest(n.rules), n.at);
  r.insertGame({
    id,
    ownerUserId: n.owner && "userId" in n.owner ? n.owner.userId : null,
    ownerGuestId: n.owner && "guestId" in n.owner ? n.owner.guestId : null,
    mode: n.mode,
    seed: n.seed,
    challengeId: n.challengeId ?? null,
    matchId: n.matchId ?? null,
    seat: n.seat ?? null,
    botLabel: n.botLabel ?? null,
    createdAt: n.at,
    state,
  });
  r.insertSnapshot({ gameId: id, revision: 0, stateJson: engine.serialize(state), stateChecksum: engine.stateChecksum(state), createdAt: n.at });
  return r.get(id)!;
}

function owns(g: StoredGame, o: Owner): boolean {
  return "userId" in o ? g.ownerUserId === o.userId : g.ownerGuestId === o.guestId;
}

function encodeCursor(g: { updatedAt: string; id: string }): string {
  return Buffer.from(`${g.updatedAt}|${g.id}`, "utf8").toString("base64url");
}
function decodeCursor(c: string): { updatedAt: string; id: string } {
  const [updatedAt, id, extra] = Buffer.from(c, "base64url").toString("utf8").split("|");
  if (extra !== undefined || !updatedAt || !id || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(updatedAt) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw validation("Invalid cursor");
  }
  return { updatedAt, id };
}

type TransitionResult = {
  next: GameState | null; // null => valid no-op
  direction: Direction | null;
  scoreDelta: string;
  events: MoveResponse["events"];
};

type Actor = Owner | "system";

export class GameService {
  readonly #d: GameServiceDeps;
  #hooks: GameHooks | null = null;

  constructor(deps: GameServiceDeps) {
    this.#d = deps;
  }

  setHooks(hooks: GameHooks): void {
    this.#hooks = hooks;
  }

  #now(): string {
    return (this.#d.now?.() ?? new Date()).toISOString();
  }

  #publish(outbox: Outbox): void {
    if (outbox.items.length > 0) this.#d.publish?.(outbox.items);
  }

  /** Load a stored game and validate its state; corruption surfaces as INTERNAL_ERROR, not a bad answer. */
  #checked(g: StoredGame): StoredGame {
    try {
      return { ...g, state: engine.validateState(g.state) };
    } catch (err) {
      if (err instanceof DomainError) throw new DomainError("INTERNAL_ERROR", "Stored game state failed validation", { gameId: g.id });
      throw err;
    }
  }

  view(g: StoredGame, undoAvailable: number): GameView {
    const hideSeed = (g.mode === "ranked" || g.mode === "duel") && g.state.status === "active";
    return {
      id: g.id,
      mode: g.mode,
      rulesetVersion: g.rulesetVersion,
      engineVersion: g.engineVersion,
      seed: hideSeed ? null : g.seed,
      state: g.state,
      undoAvailable,
      ...(g.challengeId ? { challengeId: g.challengeId } : {}),
      ...(g.matchId ? { matchId: g.matchId } : {}),
      ...(g.seat !== null ? { seat: g.seat } : {}),
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  }

  /** GameView for a stored game, validating state first. */
  viewIn(raw: SqliteDatabase, g: StoredGame): GameView {
    return this.view(this.#checked(g), createRepos(raw).games.undoDepth(g.id));
  }

  #rulesFor(g: StoredGame): Ruleset {
    const rules = resolveRules(g.rulesetVersion);
    if (!rules) throw new DomainError("INTERNAL_ERROR", "Unknown ruleset on stored game", { ruleset: g.rulesetVersion });
    return rules;
  }

  /** Owner, or (read-only) a human seat of the same match so split boards and finished replays work. */
  #canRead(raw: SqliteDatabase, g: StoredGame, o: Owner): boolean {
    if (owns(g, o)) return true;
    if (!g.matchId || !("userId" in o)) return false;
    return createRepos(raw).competition.seats(g.matchId).some((s) => s.accountId === o.userId);
  }

  async create(owner: Owner, input: CreateGameInput): Promise<GameView> {
    let rules: Ruleset;
    let seed: string;
    if (input.mode === "classic") {
      if (input.custom !== undefined) throw validation("Custom settings are only allowed in practice mode");
      rules = CLASSIC_RULES;
      seed = randomBytes(16).toString("hex");
    } else if (input.mode === "practice") {
      const c = input.custom ?? {};
      try {
        rules = customRules({ boardSize: c.boardSize ?? 4, ...(c.spawnFourTenths !== undefined ? { spawnFourTenths: c.spawnFourTenths } : {}) });
      } catch (err) {
        throw validation(err instanceof RangeError ? err.message : "Invalid custom settings");
      }
      seed = c.seed ?? randomBytes(16).toString("hex");
    } else {
      throw validation("Bot exhibition games are created through POST /bots/runs");
    }
    const at = this.#now();
    const limit = this.#d.config.limits.maxActiveGamesPerOwner;
    return this.#d.queue.submit((raw) => {
      const r = createRepos(raw).games;
      const active = r.list({ ...("userId" in owner ? { ownerUserId: owner.userId } : { ownerGuestId: owner.guestId }), status: "active", limit: limit + 1 });
      if (active.length >= limit) {
        throw new DomainError("RESOURCE_LIMIT", `Too many active games (limit ${limit}); finish or forfeit one first`);
      }
      const stored = createGameRecord(raw, { owner, mode: input.mode, rules, seed, at });
      return this.view(stored, 0);
    });
  }

  get(owner: Owner, gameId: string): GameView {
    return this.#d.db.read((raw) => {
      const g = createRepos(raw).games.get(gameId);
      if (!g || !this.#canRead(raw, g, owner)) throw notFound("Game not found");
      return this.viewIn(raw, g);
    });
  }

  /** Authorization check used by the realtime layer. */
  canRead(owner: Owner, gameId: string): boolean {
    return this.#d.db.read((raw) => {
      const g = createRepos(raw).games.get(gameId);
      return !!g && this.#canRead(raw, g, owner);
    });
  }

  list(owner: Owner, q: { status: "active" | "completed" | "forfeited" | "all"; cursor?: string | undefined; limit: number }): Page<GameView> {
    return this.#d.db.read((raw) => {
      const r = createRepos(raw).games;
      const rows = r.list({
        ...("userId" in owner ? { ownerUserId: owner.userId } : { ownerGuestId: owner.guestId }),
        ...(q.status !== "all" ? { status: q.status } : {}),
        ...(q.cursor ? { after: decodeCursor(q.cursor) } : {}),
        limit: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((g) => this.view(g, r.undoDepth(g.id))),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
      };
    });
  }

  events(owner: Owner, gameId: string, q: { cursor: number; limit: number }): EventsPage {
    return this.#d.db.read((raw) => {
      const r = createRepos(raw).games;
      const g = r.get(gameId);
      if (!g || !this.#canRead(raw, g, owner)) throw notFound("Game not found");
      const rows = r.movesAfter(gameId, q.cursor, q.limit);
      const last = rows[rows.length - 1];
      return {
        events: rows.map((m) => ({
          sequence: m.revision,
          direction: m.direction as Direction,
          events: JSON.parse(m.eventsJson) as EventsPage["events"][number]["events"],
          checksum: m.checksum,
        })),
        nextCursor: rows.length === q.limit && last ? last.revision : null,
      };
    });
  }

  /**
   * Shared command pipeline, one atomic transaction:
   * stored-response replay (idempotency) -> ownership -> revision check -> pure transition -> persist -> hooks.
   * `hashInput` is the normalized payload; the same command id with a different payload is IDEMPOTENCY_CONFLICT.
   * Realtime events are collected in an outbox and published only after COMMIT.
   */
  async #command(
    actor: Actor,
    gameId: string,
    commandId: string,
    kind: MoveKind,
    expectedRevision: number | null,
    hashInput: string,
    transition: (g: StoredGame, rules: Ruleset, repos: ReturnType<typeof createRepos>["games"], at: string) => TransitionResult,
  ): Promise<MoveResponse> {
    const requestHash = sha256(`${kind}\n${hashInput}`);
    const outbox = new Outbox();
    const response = await this.#d.queue.submit((raw) => {
      const repos = createRepos(raw);
      const r = repos.games;
      const stored = r.get(gameId);
      if (!stored) throw notFound("Game not found");
      if (actor !== "system" && !owns(stored, actor)) throw notFound("Game not found");

      const prior = r.getCommand(gameId, commandId);
      if (prior) {
        if (prior.requestHash !== requestHash || prior.kind !== kind) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "This commandId was already used with a different request");
        }
        return JSON.parse(prior.responseJson) as MoveResponse;
      }

      const g = this.#checked(stored);
      if (expectedRevision !== null && expectedRevision !== g.state.revision) {
        throw new DomainError("REVISION_CONFLICT", "The game changed; reload and retry", { currentRevision: g.state.revision });
      }
      const at = this.#now();
      const rules = this.#rulesFor(g);
      const t = transition(g, rules, r, at);

      if (t.next === null) {
        const noop: MoveResponse = {
          game: this.view(g, r.undoDepth(gameId)),
          changed: false,
          scoreDelta: "0",
          events: [],
          sequence: g.state.revision,
          code: "NO_CHANGE",
        };
        r.insertCommand({ gameId, commandId, kind, requestHash, responseJson: JSON.stringify(noop), revisionAfter: g.state.revision }, at);
        return noop;
      }

      const next = t.next;
      r.saveState(gameId, next, at);
      r.insertMove({
        gameId, revision: next.revision, commandId, kind, direction: t.direction, acceptedMoves: next.acceptedMoves,
        eventsJson: JSON.stringify(t.events), checksum: engine.stateChecksum(next), createdAt: at,
      });
      if (kind === "move" && next.acceptedMoves % SNAPSHOT_INTERVAL === 0) {
        r.insertSnapshot({ gameId, revision: next.revision, stateJson: engine.serialize(next), stateChecksum: engine.stateChecksum(next), createdAt: at });
      }
      const changed: MoveResponse = {
        game: this.view({ ...g, state: next, updatedAt: at }, r.undoDepth(gameId)),
        changed: true,
        scoreDelta: t.scoreDelta,
        events: t.events,
        sequence: next.revision,
      };
      r.insertCommand({ gameId, commandId, kind, requestHash, responseJson: JSON.stringify(changed), revisionAfter: next.revision }, at);
      outbox.push("game.updated", gameId, next.revision, { game: changed.game });
      this.#hooks?.afterChange({ raw, game: g, next, kind, at, outbox });
      return changed;
    });
    this.#publish(outbox);
    return response;
  }

  move(owner: Actor, gameId: string, req: { commandId: string; expectedRevision: number | null; direction: Direction }): Promise<MoveResponse> {
    return this.#command(owner, gameId, req.commandId, "move", req.expectedRevision, `${req.direction}\n${req.expectedRevision}`, (g, rules, r) => {
      if (g.state.status !== "active") throw forbidden(`The game is ${g.state.status}`);
      const result = engine.applyMove(g.state, req.direction, rules);
      if (!result.changed) return { next: null, direction: req.direction, scoreDelta: "0", events: [] };
      if (rules.undoLimit > 0) r.pushUndo(g.id, g.state, rules.undoLimit);
      return { next: result.state, direction: req.direction, scoreDelta: result.scoreDelta, events: result.events };
    });
  }

  undo(owner: Owner, gameId: string, req: { commandId: string; expectedRevision: number }): Promise<MoveResponse> {
    return this.#command(owner, gameId, req.commandId, "undo", req.expectedRevision, `${req.expectedRevision}`, (g, rules, r) => {
      if (rules.official || rules.undoLimit === 0) throw forbidden("Undo is not available in this mode");
      if (g.state.status === "forfeited") throw forbidden("The game was forfeited");
      const top = r.peekUndo(g.id);
      if (!top) throw forbidden("Nothing to undo");
      const previous = engine.deserialize(top.stateJson);
      r.popUndo(g.id, top.acceptedMoves);
      // Restore the full earlier state (board, score, PRNG, counters) but keep revision monotone.
      const restored: GameState = { ...previous, revision: g.state.revision + 1, status: "active" };
      return { next: restored, direction: null, scoreDelta: "0", events: [] };
    });
  }

  forfeit(owner: Owner, gameId: string, req: { commandId: string; expectedRevision: number }): Promise<MoveResponse> {
    return this.#command(owner, gameId, req.commandId, "forfeit", req.expectedRevision, `${req.expectedRevision}`, (g, _rules, r) => {
      if (g.state.status !== "active") throw forbidden(`The game is already ${g.state.status}`);
      r.clearUndo(g.id);
      return { next: { ...g.state, status: "forfeited", revision: g.state.revision + 1 }, direction: null, scoreDelta: "0", events: [] };
    });
  }

  /**
   * System-side termination (a bot run ended or was cancelled). Idempotent per commandId; a game that is
   * already terminal is left untouched. `completed` = the run reached its budget, `forfeited` = it was cancelled.
   */
  systemEnd(gameId: string, status: "completed" | "forfeited", commandId: string): Promise<MoveResponse | null> {
    return this.#command("system", gameId, commandId, "end", null, status, (g, _rules, r) => {
      if (g.state.status !== "active") return { next: null, direction: null, scoreDelta: "0", events: [] };
      r.clearUndo(g.id);
      return { next: { ...g.state, status, revision: g.state.revision + 1 }, direction: null, scoreDelta: "0", events: [] };
    });
  }
}
