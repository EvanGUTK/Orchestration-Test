import { createHash, randomUUID } from "node:crypto";
import {
  DISPLAY_NAME_MAX,
  ENGINE_VERSION,
  LIMITS,
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  PRACTICE_RULESET_VERSION,
  REPLAY_SCHEMA_VERSION,
  RULESETS,
  practiceRuleset,
  type GameMode,
  type GameState,
  type ReplayFile,
  type Ruleset,
} from "@g2048/contracts";
import {
  canonicalRulesetJson,
  competitionRepo,
  gamesRepo,
  isSqliteConstraint,
  usersRepo,
  type GameOwnerRef,
} from "@g2048/database";
import {
  applyMove,
  canonicalJson,
  checksum,
  isDirection,
  isEngineError,
  newGame,
  validateRuleset,
} from "@g2048/engine";
import { AppError } from "../http/errors.js";
import type { ServiceContext } from "./context.js";
import { nowIso } from "./context.js";
import { GameIntegrityError, type GameService } from "./game-service.js";
import { FailureRateLimiter } from "./rate-limiter.js";

/** Modes an owner may export (bot-lab games included); duel/bot-vs-bot replays belong to matches. */
const OWNER_EXPORT_MODES: readonly GameMode[] = [
  "classic",
  "practice",
  "ranked",
  "bot-exhibition",
  "duel-human",
];
/** Finished competitive games are public: anyone on this machine may replay them (redacted meta). */
const PUBLIC_EXPORT_MODES: readonly GameMode[] = ["ranked", "duel-human"];
/** Competitive games are never exported while active (the file would reveal the PRNG). */
const ACTIVE_HIDDEN_MODES: readonly GameMode[] = ["ranked", "duel-human", "duel-bot", "bot-vs-bot"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;

/** Per-owner storage quota for imported replays (SEC-004-H1). */
export const REPLAY_IMPORT_QUOTA = { files: 50, bytes: 50 * 1024 * 1024 } as const;
/** Imports per client (and per owner) per minute (SEC-004-H1). */
export const REPLAY_IMPORTS_PER_MINUTE = 10;
/**
 * Moves verified per event-loop turn. Verification yields between chunks so a large import never
 * blocks other requests for long (SEC-004-M2).
 */
const VERIFY_CHUNK = 500;
const MAX_SEED_LENGTH = 128;

export type ImportResult = {
  id: string;
  rulesetVersion: string;
  moves: number;
  finalChecksum: string;
  score: string;
};

/** A fully verified, normalized replay ready to be stored (no client-supplied extra keys). */
export type VerifiedImport = { file: ReplayFile; rules: Ruleset; sizeBytes: number; finalScore: string };

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("IMPORT_INVALID", message, details);
}

function owns(owner: GameOwnerRef | null, userId: string | null, guestId: string | null): boolean {
  if (!owner) return false;
  return "userId" in owner ? owner.userId === userId : owner.guestId === guestId;
}

function sameOutcome(a: GameState, b: GameState): boolean {
  return (
    a.score === b.score &&
    a.acceptedMoves === b.acceptedMoves &&
    JSON.stringify(a.board) === JSON.stringify(b.board) &&
    JSON.stringify(a.rng.words) === JSON.stringify(b.rng.words)
  );
}

/** Same value as engine `checksum` (SHA-256 of the canonical JSON), computed with node:crypto. */
export function fastChecksum(state: GameState): string {
  return createHash("sha256").update(canonicalJson(state), "utf8").digest("hex");
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Replays (REP-01..03, CONTRACT-001 C12/C16).
 *
 * Export (`GET /replays/:id`, id = game id or import id) — publicity policy:
 *  - the owner may export their own classic/practice/ranked/bot-exhibition/duel game; competitive
 *    (ranked/duel) games only once they are no longer active (a duel seat only once its MATCH is
 *    finished, so a replay never leaks the shared seed to the opponent mid-duel);
 *  - anyone may export a FINISHED ranked game or a human-duel seat of a FINISHED match: these are
 *    the public competitive record. Challenge seeds are not secret either (PROJECT_SCOPE: local users
 *    can read app files);
 *  - `meta.displayName` is the owning account's display name (null for guests); no account id,
 *    username, session, or credential material is ever included;
 *  - the file always carries `rules`; `moves` is the final path with canonical revisions 1..n and
 *    checksums re-derived with the engine, checked against the saved game before it is returned.
 * Import (`POST /replays/import`): verified BEFORE any identity is created, in chunks that yield to
 * the event loop; rate limited per client and owner; quota 50 files / 50 MiB per owner; stored
 * normalized (canonical initial state, known keys only) in `replay_imports`, never a game or ranked.
 */
export class ReplayService {
  readonly #ctx: ServiceContext;
  readonly #games: GameService;
  readonly #limiter: FailureRateLimiter;

  constructor(ctx: ServiceContext, games: GameService) {
    this.#ctx = ctx;
    this.#games = games;
    this.#limiter = new FailureRateLimiter({
      limit: REPLAY_IMPORTS_PER_MINUTE,
      windowMs: 60_000,
      now: () => ctx.clock().getTime(),
    });
  }

  export(owner: GameOwnerRef | null, id: string): ReplayFile {
    if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Replay not found");
    const { db } = this.#ctx;
    const imported = competitionRepo.getReplayImport(db, id);
    if (imported) {
      if (!owns(owner, imported.ownerUserId, imported.ownerGuestId))
        throw new AppError("NOT_FOUND", "Replay not found");
      return JSON.parse(imported.replayJson) as ReplayFile;
    }
    const game = gamesRepo.get(db, id);
    if (!game) throw new AppError("NOT_FOUND", "Replay not found");
    const isOwner = owns(owner, game.ownerUserId, game.ownerGuestId);
    let finished = game.state.status !== "active";
    if (game.mode.startsWith("duel-")) finished = competitionRepo.matchStatusForGame(db, id) === "finished";
    const allowed =
      (isOwner &&
        OWNER_EXPORT_MODES.includes(game.mode) &&
        (finished || !ACTIVE_HIDDEN_MODES.includes(game.mode))) ||
      (finished && PUBLIC_EXPORT_MODES.includes(game.mode));
    if (!allowed) throw new AppError("NOT_FOUND", "Replay not found");

    const rules = this.#games.rulesOf(game);
    const initial = this.#games.stateAtInTransaction(db, id, 0);
    let state = initial;
    const moves: ReplayFile["moves"] = [];
    for (const direction of this.#games.finalPathInTransaction(db, id)) {
      const result = applyMove(state, direction, rules);
      if (!result.changed) throw new GameIntegrityError(id, "final path contains a no-op");
      state = result.state;
      moves.push({ revision: state.revision, direction, checksum: fastChecksum(state) });
    }
    if (!sameOutcome(state, game.state))
      throw new GameIntegrityError(id, "final path does not reproduce the game");
    const user = game.ownerUserId ? usersRepo.findById(db, game.ownerUserId) : null;
    return {
      replaySchemaVersion: REPLAY_SCHEMA_VERSION,
      engineVersion: initial.engineVersion,
      rulesetVersion: game.rulesetVersion,
      rules,
      seed: game.seed,
      initialState: initial,
      initialChecksum: checksum(initial),
      moves,
      finalChecksum: checksum(state),
      meta: {
        mode: game.mode,
        displayName: user?.displayName ?? null,
        createdAt: game.createdAt,
        source: "local",
      },
    };
  }

  /**
   * Validates and verifies an uploaded replay WITHOUT touching the database or creating identities.
   * Rate limited per client before any work. Returns the normalized file to store.
   */
  async verifyImport(body: unknown, sizeBytes: number, clientKey: string): Promise<VerifiedImport> {
    const decision = this.#limiter.reserve(`import-client:${clientKey}`);
    if (!decision.allowed) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      throw new AppError(
        "RATE_LIMITED",
        "Too many replay imports; try again later",
        { retryAfterSeconds: seconds },
        {
          "retry-after": String(seconds),
        },
      );
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes > LIMITS.replayImportBytes) {
      throw invalid(`Replay files are limited to ${LIMITS.replayImportBytes} bytes`);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body))
      throw invalid("Replay must be a JSON object");
    const file = body as Record<string, unknown>;
    if (file.replaySchemaVersion !== REPLAY_SCHEMA_VERSION) {
      throw new AppError(
        "REPLAY_VERSION_UNSUPPORTED",
        `Only replay schema version ${REPLAY_SCHEMA_VERSION} is supported`,
      );
    }
    if (file.engineVersion !== ENGINE_VERSION) {
      throw new AppError(
        "REPLAY_VERSION_UNSUPPORTED",
        `Only engine version ${ENGINE_VERSION} replays are supported`,
      );
    }
    if (typeof file.seed !== "string" || file.seed.length < 1 || file.seed.length > MAX_SEED_LENGTH) {
      throw invalid(`Replay seed must be 1-${MAX_SEED_LENGTH} characters`, { field: "seed" });
    }
    if (!Array.isArray(file.moves)) throw invalid("Replay has no move list", { field: "moves" });
    if (file.moves.length > LIMITS.replayMaxMoves) {
      throw invalid(`Replays are limited to ${LIMITS.replayMaxMoves} moves`, { field: "moves" });
    }
    const meta = file.meta as Record<string, unknown> | undefined;
    if (
      !meta ||
      typeof meta !== "object" ||
      typeof meta.mode !== "string" ||
      meta.mode.length > 32 ||
      typeof meta.createdAt !== "string" ||
      meta.createdAt.length > 40 ||
      !(
        meta.displayName === null ||
        (typeof meta.displayName === "string" && [...meta.displayName].length <= DISPLAY_NAME_MAX)
      )
    ) {
      throw invalid("Replay metadata is missing or malformed", { field: "meta" });
    }
    if (typeof file.initialChecksum !== "string" || typeof file.finalChecksum !== "string") {
      throw invalid("Replay checksums are missing", { field: "initialChecksum" });
    }
    const rules = this.#rulesFor(file);

    // Header: the initial state must be exactly newGame(rules, seed) (C7) and match its checksum.
    let initial: GameState;
    try {
      initial = newGame(rules, file.seed);
      if (canonicalJson(file.initialState as GameState) !== canonicalJson(initial)) {
        throw invalid("Replay initial state is not the official start for this seed and ruleset", {
          field: "initialState",
        });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw invalid("Replay initial state is malformed", { field: "initialState" });
    }
    if (file.initialChecksum !== fastChecksum(initial)) {
      throw invalid("Replay initial checksum does not match", { field: "initialChecksum" });
    }

    // Moves, verified in chunks that yield to the event loop.
    let state = initial;
    const moves: ReplayFile["moves"] = [];
    const list = file.moves as unknown[];
    for (let i = 0; i < list.length; i += 1) {
      if (i > 0 && i % VERIFY_CHUNK === 0) await yieldToEventLoop();
      const move = list[i];
      if (move === null || typeof move !== "object")
        throw invalid("Replay move must be an object", { atMove: i });
      const { direction, revision, checksum: recorded } = move as Record<string, unknown>;
      if (!isDirection(direction)) throw invalid("Replay move has an invalid direction", { atMove: i });
      if (typeof recorded !== "string" || !CHECKSUM.test(recorded)) {
        throw invalid("Replay move has an invalid checksum", { atMove: i });
      }
      let result;
      try {
        result = applyMove(state, direction, rules);
      } catch (error) {
        if (isEngineError(error) && error.code === "REPLAY_VERSION_UNSUPPORTED") {
          throw new AppError("REPLAY_VERSION_UNSUPPORTED", "Replay uses an unsupported version", {
            atMove: i,
          });
        }
        throw invalid("Replay move could not be applied", { atMove: i });
      }
      if (!result.changed)
        throw invalid("Replay contains a move that does not change the board", { atMove: i });
      if (revision !== result.state.revision)
        throw invalid("Replay move revision does not match", { atMove: i });
      const sum = fastChecksum(result.state);
      if (recorded !== sum) throw invalid("Replay move checksum does not match", { atMove: i });
      state = result.state;
      moves.push({ revision: result.state.revision, direction, checksum: sum });
    }
    const finalChecksum = fastChecksum(state);
    if (file.finalChecksum !== finalChecksum)
      throw invalid("Replay final checksum does not match", { field: "finalChecksum" });

    const normalized: ReplayFile = {
      replaySchemaVersion: REPLAY_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      rulesetVersion: rules.version,
      rules,
      seed: file.seed,
      initialState: JSON.parse(canonicalJson(initial)) as GameState, // canonical: no client extra keys
      initialChecksum: file.initialChecksum,
      moves,
      finalChecksum,
      meta: {
        mode: meta.mode,
        displayName: (meta.displayName as string | null) ?? null,
        createdAt: meta.createdAt,
        source: "import",
      },
    };
    return {
      file: normalized,
      rules,
      sizeBytes: Math.max(1, Math.trunc(sizeBytes)),
      finalScore: state.score,
    };
  }

  /** Stores a verified import for `owner`, enforcing the per-owner rate limit and quota in the txn. */
  async storeImport(owner: GameOwnerRef, verified: VerifiedImport): Promise<ImportResult> {
    const ownerKey = "userId" in owner ? `import-user:${owner.userId}` : `import-guest:${owner.guestId}`;
    const decision = this.#limiter.reserve(ownerKey);
    if (!decision.allowed) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      throw new AppError(
        "RATE_LIMITED",
        "Too many replay imports; try again later",
        { retryAfterSeconds: seconds },
        {
          "retry-after": String(seconds),
        },
      );
    }
    const id = randomUUID();
    const json = JSON.stringify(verified.file);
    try {
      await this.#ctx.writer.run((db) => {
        const usage = competitionRepo.replayImportUsage(db, owner);
        if (
          usage.count >= REPLAY_IMPORT_QUOTA.files ||
          usage.bytes + verified.sizeBytes > REPLAY_IMPORT_QUOTA.bytes
        ) {
          throw new AppError(
            "RESOURCE_LIMIT",
            `Imported replays are limited to ${REPLAY_IMPORT_QUOTA.files} files / ${REPLAY_IMPORT_QUOTA.bytes / 1024 / 1024} MiB per profile`,
          );
        }
        competitionRepo.insertReplayImport(db, {
          id,
          ownerUserId: "userId" in owner ? owner.userId : null,
          ownerGuestId: "guestId" in owner ? owner.guestId : null,
          replaySchemaVersion: REPLAY_SCHEMA_VERSION,
          engineVersion: ENGINE_VERSION,
          rulesetVersion: verified.rules.version,
          finalChecksum: verified.file.finalChecksum,
          moves: verified.file.moves.length,
          sizeBytes: verified.sizeBytes,
          replayJson: json,
          now: nowIso(this.#ctx),
        });
      });
    } catch (error) {
      if (isSqliteConstraint(error)) throw invalid("Replay could not be stored (invalid field values)");
      throw error;
    }
    return {
      id,
      rulesetVersion: verified.rules.version,
      moves: verified.file.moves.length,
      finalChecksum: verified.file.finalChecksum,
      score: verified.finalScore,
    };
  }

  /**
   * Rules to verify a replay with (C16). `rules` must be a valid ruleset whose version equals
   * `rulesetVersion`; built-in versions must match this build's ruleset exactly; practice rules must stay
   * casual. Built-in files without `rules` use this build's ruleset; practice-v1 REQUIRES `rules`.
   */
  #rulesFor(file: Record<string, unknown>): Ruleset {
    const version = file.rulesetVersion;
    if (typeof version !== "string" || version.length > 32) {
      throw invalid("Replay has no valid ruleset version", { field: "rulesetVersion" });
    }
    const builtin = (RULESETS as Record<string, Ruleset>)[version];
    if (!builtin && version !== PRACTICE_RULESET_VERSION)
      throw invalid("Unknown ruleset", { field: "rulesetVersion" });
    if (file.rules === undefined) {
      if (builtin) return builtin;
      throw invalid("Practice replays must include their rules", { field: "rules" });
    }
    const rules = file.rules;
    try {
      validateRuleset(rules);
    } catch {
      throw invalid("Replay rules are malformed", { field: "rules" });
    }
    if (rules.version !== version)
      throw invalid("rules.version does not match rulesetVersion", { field: "rules" });
    if (builtin) {
      if (canonicalRulesetJson(rules) !== canonicalRulesetJson(builtin)) {
        throw invalid("Replay rules differ from the official ruleset", { field: "rules" });
      }
      return builtin;
    }
    if (
      rules.ranked ||
      rules.moveCap !== null ||
      rules.size < MIN_BOARD_SIZE ||
      rules.size > MAX_BOARD_SIZE
    ) {
      throw invalid("Practice replay rules are not valid practice rules", { field: "rules" });
    }
    return practiceRuleset({ size: rules.size, fourWeight: rules.fourWeight, undo: rules.undo });
  }
}
