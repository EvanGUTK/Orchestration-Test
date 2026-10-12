import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as engine from "@2048/engine";
import { boardMaxExponent } from "@2048/competition";
import { createRepos, type GameDb, type WriteQueue } from "@2048/database";
import {
  ENGINE_VERSION, REPLAY_SCHEMA_VERSION, SNAPSHOT_INTERVAL, DomainError, isDecimal, resolveRules,
  type Direction, type GameState, type Page, type ReplaySummary, type ReplayView,
} from "@2048/contracts";
import { forbidden, notFound, validation } from "../errors.ts";
import type { Principal } from "./accounts.ts";

export const IMPORT_MAX_BYTES = 16 * 1024 * 1024;
export const IMPORT_MAX_MOVES = 100_000;
const MAX_IMPORTS_PER_OWNER = 20;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const direction = z.enum(["up", "right", "down", "left"]);

const importShape = z.strictObject({
  schemaVersion: z.number(),
  engineVersion: z.string().min(1).max(64),
  rulesetVersion: z.string().min(1).max(128),
  ruleset: z.strictObject({
    version: z.string(), boardSize: z.number().int(), moveCap: z.number().int().nullable(), startTiles: z.number().int(),
    spawnFourTenths: z.number().int(), undoLimit: z.number().int(), official: z.boolean(),
  }),
  seed: z.string().min(1).max(128),
  moves: z.array(z.strictObject({ sequence: z.number().int().min(1), direction, checksum: hex64 })).max(IMPORT_MAX_MOVES),
  snapshots: z.array(z.strictObject({ sequence: z.number().int().min(0), checksum: hex64, state: z.unknown() })).max(IMPORT_MAX_MOVES / SNAPSHOT_INTERVAL + 2),
  finalChecksum: hex64,
  finalScore: z.string().max(4_000_000),
  undoMarkers: z.array(z.strictObject({ atSequence: z.number().int().min(0), branch: z.number().int().min(1) })).max(IMPORT_MAX_MOVES),
});

const cursorOf = (r: { createdAt: string; id: string }) => Buffer.from(`${r.createdAt}|${r.id}`, "utf8").toString("base64url");
function parseCursor(raw: string): { createdAt: string; id: string } {
  const [createdAt, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (extra !== undefined || !createdAt || !id || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(createdAt)) throw validation("Invalid cursor");
  return { createdAt, id };
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export type ReplayDeps = { db: GameDb; queue: WriteQueue; now?: () => Date };

export class ReplayService {
  readonly #d: ReplayDeps;

  constructor(deps: ReplayDeps) {
    this.#d = deps;
  }

  list(p: Principal, q: { cursor?: string | undefined; limit: number }): Page<ReplaySummary> {
    return this.#d.db.read((raw) => {
      const rows = createRepos(raw).replays.list(
        p.kind === "user" ? { userId: p.userId } : { guestId: p.userId },
        q.cursor ? parseCursor(q.cursor) : undefined,
        q.limit + 1,
      );
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => ({
          gameId: r.id, mode: r.mode as ReplaySummary["mode"], rulesetVersion: r.rulesetVersion, finalScore: r.score, maxExponent: r.maxExponent,
          acceptedMoves: r.acceptedMoves, createdAt: r.createdAt,
        })),
        nextCursor: rows.length > q.limit && last ? cursorOf(last) : null,
      };
    });
  }

  /** Versioned replay for a finished game (owner, or a seat of a finished match) or an imported replay. */
  get(p: Principal, id: string): ReplayView {
    return this.#d.db.read((raw) => {
      const repos = createRepos(raw);
      const imp = repos.replays.getImport(id);
      if (imp) {
        const mine = p.kind === "user" ? imp.ownerUserId === p.userId : imp.ownerGuestId === p.userId;
        if (!mine) throw notFound("Replay not found");
        return JSON.parse(imp.replayJson) as ReplayView;
      }
      const g = repos.games.get(id);
      if (!g) throw notFound("Replay not found");
      const owner = p.kind === "user" ? g.ownerUserId === p.userId : g.ownerGuestId === p.userId;
      let allowed = owner;
      if (!allowed && g.matchId && p.kind === "user") {
        const m = repos.competition.match(g.matchId);
        allowed = !!m && m.status === "finished" && repos.competition.seats(m.id).some((s) => s.accountId === p.userId);
      }
      if (!allowed) throw notFound("Replay not found");
      if ((g.mode === "ranked" || g.mode === "duel") && g.state.status === "active") {
        throw forbidden("The replay becomes available when the game ends");
      }
      return this.#build(raw, g.id);
    });
  }

  #build(raw: Parameters<Parameters<GameDb["read"]>[0]>[0], gameId: string): ReplayView {
    const repos = createRepos(raw);
    const g = repos.games.get(gameId)!;
    const rules = resolveRules(g.rulesetVersion);
    if (!rules) throw new DomainError("REPLAY_VERSION_UNSUPPORTED", "Unknown ruleset for this game");
    const rows = repos.games.allMoves(gameId);

    // Effective path: undo pops the last accepted move; markers record where each undo happened.
    const path: { direction: Direction; checksum: string }[] = [];
    const undoMarkers: ReplayView["undoMarkers"] = [];
    for (const r of rows) {
      if (r.kind === "move") path.push({ direction: r.direction!, checksum: r.checksum });
      else if (r.kind === "undo") {
        undoMarkers.push({ atSequence: path.length, branch: undoMarkers.length + 1 });
        path.pop();
      }
    }

    const initial = engine.newGame(rules, g.seed);
    let moves: ReplayView["moves"];
    let snapshots: ReplayView["snapshots"];
    let finalChecksum: string;
    let finalScore: string;
    if (undoMarkers.length === 0) {
      // No undo ever happened: revision == acceptedMoves, so stored checksums/snapshots are replay-normalized already.
      moves = path.map((m, i) => ({ sequence: i + 1, direction: m.direction, checksum: m.checksum }));
      snapshots = repos.games.snapshots(gameId).map((s) => ({
        sequence: s.revision, checksum: s.stateChecksum, state: JSON.parse(s.stateJson) as GameState,
      }));
      finalChecksum = moves.length ? moves[moves.length - 1]!.checksum : engine.stateChecksum(initial);
      finalScore = g.state.score;
    } else {
      let state = initial;
      moves = [];
      snapshots = [{ sequence: 0, checksum: engine.stateChecksum(initial), state: initial }];
      path.forEach((m, i) => {
        state = engine.applyMove(state, m.direction, rules).state;
        const checksum = engine.stateChecksum(state);
        moves.push({ sequence: i + 1, direction: m.direction, checksum });
        if ((i + 1) % SNAPSHOT_INTERVAL === 0) snapshots.push({ sequence: i + 1, checksum, state });
      });
      finalChecksum = engine.stateChecksum(state);
      finalScore = state.score;
    }
    return {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      engineVersion: g.engineVersion,
      rulesetVersion: g.rulesetVersion,
      ruleset: rules,
      seed: g.seed,
      moves,
      snapshots,
      finalChecksum,
      finalScore,
      undoMarkers,
    };
  }

  /**
   * Validate and install an imported replay. Nothing is stored unless the ENTIRE replay re-executes on the
   * authoritative engine to the claimed checksums. Imports are casual: they are never ranked or on a board.
   */
  async import(p: Principal, body: unknown): Promise<ReplaySummary> {
    const reject = (message: string, details?: unknown): never => {
      throw new DomainError("IMPORT_INVALID", message, details);
    };
    if (typeof body !== "object" || body === null || Array.isArray(body)) reject("Replay must be a JSON object");
    const version = (body as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === "number" && version !== REPLAY_SCHEMA_VERSION) {
      throw new DomainError("REPLAY_VERSION_UNSUPPORTED", `Replay schema version ${version} is not supported (expected ${REPLAY_SCHEMA_VERSION})`);
    }
    const parsed = importShape.safeParse(body);
    if (!parsed.success) {
      return reject("Replay file is malformed", { issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const r = parsed.data;
    if (r.schemaVersion !== REPLAY_SCHEMA_VERSION) reject("Unsupported replay schema version");
    if (r.engineVersion !== ENGINE_VERSION) {
      throw new DomainError("REPLAY_VERSION_UNSUPPORTED", `Engine version ${r.engineVersion} is not supported (expected ${ENGINE_VERSION})`);
    }
    const rules = resolveRules(r.rulesetVersion);
    if (!rules) throw new DomainError("REPLAY_VERSION_UNSUPPORTED", `Unknown ruleset ${r.rulesetVersion}`);
    if (JSON.stringify(rules) !== JSON.stringify(r.ruleset)) reject("The embedded ruleset does not match the named ruleset version");
    if (!isDecimal(r.finalScore)) reject("finalScore is not a canonical decimal");

    // Re-execute on the authoritative engine; every claim must reproduce exactly.
    let state: GameState;
    try {
      state = engine.newGame(rules, r.seed);
    } catch (err) {
      return reject(`Cannot start the replay: ${err instanceof Error ? err.message : "invalid seed"}`);
    }
    const snapshotBySeq = new Map<number, { checksum: string; state: unknown }>();
    for (const s of r.snapshots) {
      if (snapshotBySeq.has(s.sequence)) reject(`Duplicate snapshot at sequence ${s.sequence}`);
      snapshotBySeq.set(s.sequence, s);
    }
    const checkSnapshot = (seq: number): void => {
      const s = snapshotBySeq.get(seq);
      if (!s) return;
      let snap: GameState;
      try {
        snap = engine.validateState(s.state);
      } catch {
        return reject(`Snapshot ${seq} is not a valid game state`);
      }
      if (engine.stateChecksum(snap) !== s.checksum || s.checksum !== engine.stateChecksum(state)) reject(`Snapshot ${seq} does not match the replayed state`);
    };
    checkSnapshot(0);
    for (let i = 0; i < r.moves.length; i++) {
      const m = r.moves[i]!;
      if (m.sequence !== i + 1) reject(`Move sequence is not contiguous at index ${i}`);
      let res;
      try {
        res = engine.applyMove(state, m.direction, rules);
      } catch (err) {
        return reject(`Move ${m.sequence} is illegal: ${err instanceof DomainError ? err.message : "rejected by the engine"}`);
      }
      if (!res.changed) reject(`Move ${m.sequence} changes nothing, so it cannot be an accepted move`);
      state = res.state;
      if (engine.stateChecksum(state) !== m.checksum) reject(`Checksum mismatch at move ${m.sequence}`);
      checkSnapshot(m.sequence);
      if (i % 2000 === 1999) await yieldLoop();
    }
    for (const seq of snapshotBySeq.keys()) if (seq > r.moves.length) reject(`Snapshot ${seq} is beyond the last move`);
    if (engine.stateChecksum(state) !== r.finalChecksum) reject("finalChecksum does not match the replayed final state");
    if (state.score !== r.finalScore) reject("finalScore does not match the replayed final state");
    const id = randomUUID();
    const at = (this.#d.now?.() ?? new Date()).toISOString();
    const summary: ReplaySummary = {
      gameId: id, mode: "practice", rulesetVersion: rules.version, finalScore: state.score, maxExponent: boardMaxExponent(state.board),
      acceptedMoves: state.acceptedMoves, createdAt: at,
    };
    await this.#d.queue.submit((raw) => {
      const repos = createRepos(raw);
      const owner = p.kind === "user" ? { userId: p.userId } : { guestId: p.userId };
      if (repos.replays.countImports(owner) >= MAX_IMPORTS_PER_OWNER) {
        throw new DomainError("RESOURCE_LIMIT", `You can keep at most ${MAX_IMPORTS_PER_OWNER} imported replays; delete the account data or reuse them`);
      }
      repos.replays.insertImport({
        id, ownerUserId: p.kind === "user" ? p.userId : null, ownerGuestId: p.kind === "guest" ? p.userId : null, rulesetVersion: rules.version,
        seed: r.seed, finalScore: state.score, maxExponent: summary.maxExponent, acceptedMoves: state.acceptedMoves,
        finalChecksum: r.finalChecksum, replayJson: JSON.stringify(r), createdAt: at,
      });
    });
    return summary;
  }
}
