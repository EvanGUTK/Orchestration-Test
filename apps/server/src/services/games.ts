import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as engine from "@2048/engine";
import { createRepos, type GameDb, type StoredGame, type WriteQueue } from "@2048/database";
import {
  CLASSIC_RULES, DomainError, SNAPSHOT_INTERVAL, customRules, resolveRules,
  type Direction, type EventsPage, type GameState, type GameView, type MoveResponse, type Page, type Ruleset,
} from "@2048/contracts";
import type { ServerConfig } from "../config.ts";
import { forbidden, notFound, validation } from "../errors.ts";
import type { Principal } from "./accounts.ts";

export type Owner = { userId: string } | { guestId: string };
export const ownerOf = (p: Principal): Owner => (p.kind === "user" ? { userId: p.userId } : { guestId: p.userId });

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const rulesDigest = (r: Ruleset) => sha256(JSON.stringify(r));

export type CreateGameInput = {
  mode: "classic" | "practice" | "bot-exhibition";
  custom?: { boardSize?: number | undefined; seed?: string | undefined; spawnFourTenths?: number | undefined } | undefined;
};

type MoveKind = "move" | "undo" | "forfeit";

export type GameServiceDeps = { db: GameDb; queue: WriteQueue; config: ServerConfig; now?: () => Date };

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

export class GameService {
  readonly #d: GameServiceDeps;

  constructor(deps: GameServiceDeps) {
    this.#d = deps;
  }

  #now(): string {
    return (this.#d.now?.() ?? new Date()).toISOString();
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

  #view(g: StoredGame, undoAvailable: number): GameView {
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

  #rulesFor(g: StoredGame): Ruleset {
    const rules = resolveRules(g.rulesetVersion);
    if (!rules) throw new DomainError("INTERNAL_ERROR", "Unknown ruleset on stored game", { ruleset: g.rulesetVersion });
    return rules;
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
      throw validation("Bot exhibition games are created through the bot runs API");
    }
    const state = engine.newGame(rules, seed);
    const id = randomUUID();
    const at = this.#now();
    const ownerFields = "userId" in owner ? { ownerUserId: owner.userId, ownerGuestId: null } : { ownerUserId: null, ownerGuestId: owner.guestId };
    const limit = this.#d.config.limits.maxActiveGamesPerOwner;
    return this.#d.queue.submit((raw) => {
      const r = createRepos(raw).games;
      const active = r.list({ ...("userId" in owner ? { ownerUserId: owner.userId } : { ownerGuestId: owner.guestId }), status: "active", limit: limit + 1 });
      if (active.length >= limit) {
        throw new DomainError("RESOURCE_LIMIT", `Too many active games (limit ${limit}); finish or forfeit one first`);
      }
      r.ensureRuleset(rules, rulesDigest(rules), at);
      r.insertGame({ id, ...ownerFields, mode: input.mode, seed, challengeId: null, matchId: null, seat: null, createdAt: at, state });
      r.insertSnapshot({ gameId: id, revision: 0, stateJson: engine.serialize(state), stateChecksum: engine.stateChecksum(state), createdAt: at });
      const stored = r.get(id)!;
      return this.#view(stored, 0);
    });
  }

  get(owner: Owner, gameId: string): GameView {
    return this.#d.db.read((raw) => {
      const r = createRepos(raw).games;
      const g = r.get(gameId);
      if (!g || !owns(g, owner)) throw notFound("Game not found");
      return this.#view(this.#checked(g), r.undoDepth(gameId));
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
        items: page.map((g) => this.#view(g, r.undoDepth(g.id))),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
      };
    });
  }

  events(owner: Owner, gameId: string, q: { cursor: number; limit: number }): EventsPage {
    return this.#d.db.read((raw) => {
      const r = createRepos(raw).games;
      const g = r.get(gameId);
      if (!g || !owns(g, owner)) throw notFound("Game not found");
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
   * stored-response replay (idempotency) -> ownership -> revision check -> pure transition -> persist.
   * `hashInput` is the normalized payload; the same command id with a different payload is IDEMPOTENCY_CONFLICT.
   */
  #command(
    owner: Owner,
    gameId: string,
    commandId: string,
    kind: MoveKind,
    expectedRevision: number,
    hashInput: string,
    transition: (g: StoredGame, rules: Ruleset, repos: ReturnType<typeof createRepos>["games"], at: string) => {
      next: GameState | null; // null => valid no-op
      direction: Direction | null;
      scoreDelta: string;
      events: MoveResponse["events"];
      undoAfter: (r: ReturnType<typeof createRepos>["games"]) => number;
    },
  ): Promise<MoveResponse> {
    const requestHash = sha256(`${kind}\n${hashInput}`);
    return this.#d.queue.submit((raw) => {
      const r = createRepos(raw).games;
      const stored = r.get(gameId);
      if (!stored || !owns(stored, owner)) throw notFound("Game not found");

      const prior = r.getCommand(gameId, commandId);
      if (prior) {
        if (prior.requestHash !== requestHash || prior.kind !== kind) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "This commandId was already used with a different request");
        }
        return JSON.parse(prior.responseJson) as MoveResponse;
      }

      const g = this.#checked(stored);
      if (expectedRevision !== g.state.revision) {
        throw new DomainError("REVISION_CONFLICT", "The game changed; reload and retry", { currentRevision: g.state.revision });
      }
      const at = this.#now();
      const rules = this.#rulesFor(g);
      const t = transition(g, rules, r, at);

      let response: MoveResponse;
      if (t.next === null) {
        response = {
          game: this.#view(g, r.undoDepth(gameId)),
          changed: false,
          scoreDelta: "0",
          events: [],
          sequence: g.state.revision,
          code: "NO_CHANGE",
        };
        r.insertCommand({ gameId, commandId, kind, requestHash, responseJson: JSON.stringify(response), revisionAfter: g.state.revision }, at);
        return response;
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
      response = {
        game: this.#view({ ...g, state: next, updatedAt: at }, t.undoAfter(r)),
        changed: true,
        scoreDelta: t.scoreDelta,
        events: t.events,
        sequence: next.revision,
      };
      r.insertCommand({ gameId, commandId, kind, requestHash, responseJson: JSON.stringify(response), revisionAfter: next.revision }, at);
      return response;
    });
  }

  move(owner: Owner, gameId: string, req: { commandId: string; expectedRevision: number; direction: Direction }): Promise<MoveResponse> {
    return this.#command(owner, gameId, req.commandId, "move", req.expectedRevision, `${req.direction}\n${req.expectedRevision}`, (g, rules, r) => {
      if (g.state.status !== "active") throw forbidden(`The game is ${g.state.status}`);
      const result = engine.applyMove(g.state, req.direction, rules);
      if (!result.changed) {
        return { next: null, direction: req.direction, scoreDelta: "0", events: [], undoAfter: () => r.undoDepth(g.id) };
      }
      if (rules.undoLimit > 0) r.pushUndo(g.id, g.state, rules.undoLimit);
      return {
        next: result.state,
        direction: req.direction,
        scoreDelta: result.scoreDelta,
        events: result.events,
        undoAfter: () => r.undoDepth(g.id),
      };
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
      return { next: restored, direction: null, scoreDelta: "0", events: [], undoAfter: () => r.undoDepth(g.id) };
    });
  }

  forfeit(owner: Owner, gameId: string, req: { commandId: string; expectedRevision: number }): Promise<MoveResponse> {
    return this.#command(owner, gameId, req.commandId, "forfeit", req.expectedRevision, `${req.expectedRevision}`, (g, _rules, r) => {
      if (g.state.status !== "active") throw forbidden(`The game is already ${g.state.status}`);
      r.clearUndo(g.id);
      const next: GameState = { ...g.state, status: "forfeited", revision: g.state.revision + 1 };
      return { next, direction: null, scoreDelta: "0", events: [], undoAfter: () => 0 };
    });
  }
}
