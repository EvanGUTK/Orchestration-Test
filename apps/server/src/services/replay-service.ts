import { randomUUID } from "node:crypto";
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
  usersRepo,
  type GameOwnerRef,
} from "@g2048/database";
import { applyMove, canonicalJson, checksum, validateRuleset, verifyReplay } from "@g2048/engine";
import { AppError } from "../http/errors.js";
import type { ServiceContext } from "./context.js";
import { nowIso } from "./context.js";
import { GameIntegrityError, type GameService } from "./game-service.js";

/** Modes an owner may export (bot-lab games included); duel/bot-vs-bot replays belong to matches. */
const OWNER_EXPORT_MODES: readonly GameMode[] = ["classic", "practice", "ranked", "bot-exhibition"];
/** Finished competitive games are public: anyone on this machine may replay them (redacted meta). */
const PUBLIC_EXPORT_MODES: readonly GameMode[] = ["ranked", "duel-human"];
/** Competitive games are never exported while active (the file would reveal the PRNG). */
const ACTIVE_HIDDEN_MODES: readonly GameMode[] = ["ranked", "duel-human", "duel-bot", "bot-vs-bot"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ImportResult = {
  id: string;
  rulesetVersion: string;
  moves: number;
  finalChecksum: string;
  score: string;
};

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

/**
 * Replays (REP-01..03, CONTRACT-001 C12).
 *
 * Export (`GET /replays/:id`, id = game id or import id):
 *  - the owner may export their own classic/practice/ranked/bot-exhibition game; competitive
 *    (ranked/duel) games only once they are no longer active;
 *  - anyone may export a FINISHED ranked or human-duel game (public competitive record);
 *  - `meta.displayName` is the owning account's display name (null for guests); no account id,
 *    username, session, or credential material is ever included;
 *  - `initialState` is the stored revision-0 state; `moves` is the final path (accepted, not undone)
 *    with canonical replay revisions 1..n and checksums re-derived with the engine; the result is
 *    checked against the saved game before it is returned.
 * Import (`POST /replays/import`): <= LIMITS.replayImportBytes, verified with engine.verifyReplay,
 * unknown schema/engine version -> REPLAY_VERSION_UNSUPPORTED, anything else -> IMPORT_INVALID; stored
 * in `replay_imports` only (never a game, never ranked), owner-only afterwards.
 */
export class ReplayService {
  readonly #ctx: ServiceContext;
  readonly #games: GameService;

  constructor(ctx: ServiceContext, games: GameService) {
    this.#ctx = ctx;
    this.#games = games;
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
    const active = game.state.status === "active";
    const allowed =
      (isOwner &&
        OWNER_EXPORT_MODES.includes(game.mode) &&
        !(active && ACTIVE_HIDDEN_MODES.includes(game.mode))) ||
      (!active && PUBLIC_EXPORT_MODES.includes(game.mode));
    if (!allowed) throw new AppError("NOT_FOUND", "Replay not found");

    const rules = this.#games.rulesOf(game);
    const initial = this.#games.stateAtInTransaction(db, id, 0);
    let state = initial;
    const moves: ReplayFile["moves"] = [];
    for (const direction of this.#games.finalPathInTransaction(db, id)) {
      const result = applyMove(state, direction, rules);
      if (!result.changed) throw new GameIntegrityError(id, "final path contains a no-op");
      state = result.state;
      moves.push({ revision: state.revision, direction, checksum: checksum(state) });
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

  async import(owner: GameOwnerRef, body: unknown, sizeBytes: number): Promise<ImportResult> {
    if (sizeBytes > LIMITS.replayImportBytes) {
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
    const candidates = this.#rulesFor(file);
    let verified: ReturnType<typeof verifyReplay> | null = null;
    let usedRules: Ruleset | null = null;
    for (const rules of candidates) {
      const result = verifyReplay(file as unknown as ReplayFile, rules);
      if (result.ok) {
        verified = result;
        usedRules = rules;
        break;
      }
      verified = result;
    }
    if (!verified || !verified.ok || !usedRules) {
      const failure = verified && !verified.ok ? verified : null;
      if (failure?.code === "REPLAY_VERSION_UNSUPPORTED") {
        throw new AppError("REPLAY_VERSION_UNSUPPORTED", failure.message);
      }
      throw invalid(
        failure ? `Replay failed verification: ${failure.message}` : "Replay failed verification",
        {
          atMove: failure?.atMove ?? null,
        },
      );
    }
    const final = verified.final;
    const normalized: ReplayFile = {
      replaySchemaVersion: REPLAY_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      rulesetVersion: usedRules.version,
      rules: usedRules,
      seed: file.seed as string,
      initialState: file.initialState as GameState,
      initialChecksum: file.initialChecksum as string,
      moves: (file.moves as ReplayFile["moves"]).map((m) => ({
        revision: m.revision,
        direction: m.direction,
        checksum: m.checksum,
      })),
      finalChecksum: checksum(final),
      meta: {
        mode: meta.mode,
        displayName: (meta.displayName as string | null) ?? null,
        createdAt: meta.createdAt,
        source: "import",
      },
    };
    const id = randomUUID();
    await this.#ctx.writer.run((db) => {
      competitionRepo.insertReplayImport(db, {
        id,
        ownerUserId: "userId" in owner ? owner.userId : null,
        ownerGuestId: "guestId" in owner ? owner.guestId : null,
        replaySchemaVersion: REPLAY_SCHEMA_VERSION,
        engineVersion: ENGINE_VERSION,
        rulesetVersion: usedRules.version,
        finalChecksum: normalized.finalChecksum,
        moves: normalized.moves.length,
        sizeBytes: Math.max(1, sizeBytes),
        replayJson: JSON.stringify(normalized),
        now: nowIso(this.#ctx),
      });
    });
    return {
      id,
      rulesetVersion: usedRules.version,
      moves: normalized.moves.length,
      finalChecksum: normalized.finalChecksum,
      score: final.score,
    };
  }

  /**
   * Rules to verify a replay with (CONTRACT-001 C16). When the file carries `rules`, they must be a
   * valid ruleset whose version equals `rulesetVersion`; built-in versions must match this build's
   * ruleset exactly and practice rules must stay casual (no cap, unranked, size 3..8). Older files
   * without `rules`: built-ins use this build's ruleset; practice-v1 tries fourWeight 0..10.
   */
  #rulesFor(file: Record<string, unknown>): Ruleset[] {
    const version = file.rulesetVersion;
    if (typeof version !== "string")
      throw invalid("Replay has no ruleset version", { field: "rulesetVersion" });
    const builtin = (RULESETS as Record<string, Ruleset>)[version];
    if (!builtin && version !== PRACTICE_RULESET_VERSION) {
      throw invalid(`Unknown ruleset ${version}`, { field: "rulesetVersion" });
    }
    if (file.rules !== undefined) {
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
          throw invalid(`Replay rules differ from the official ${version} ruleset`, { field: "rules" });
        }
        return [builtin];
      }
      if (
        rules.ranked ||
        rules.moveCap !== null ||
        rules.size < MIN_BOARD_SIZE ||
        rules.size > MAX_BOARD_SIZE
      ) {
        throw invalid("Practice replay rules are not valid practice rules", { field: "rules" });
      }
      return [practiceRuleset({ size: rules.size, fourWeight: rules.fourWeight, undo: rules.undo })];
    }
    if (builtin) return [builtin];
    const size = (file.initialState as { board?: { size?: unknown } } | undefined)?.board?.size;
    if (
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size < MIN_BOARD_SIZE ||
      size > MAX_BOARD_SIZE
    ) {
      throw invalid("Practice replay has an invalid board size", { field: "initialState.board.size" });
    }
    return Array.from({ length: 11 }, (_, fourWeight) => practiceRuleset({ size, fourWeight, undo: true }));
  }
}

/** Exposed for tests: a canonical, comparable form of an exported replay. */
export function replayFingerprint(file: ReplayFile): string {
  return `${canonicalJson(file.initialState)}|${file.moves.map((m) => `${m.direction}:${m.checksum}`).join(",")}|${file.finalChecksum}`;
}
