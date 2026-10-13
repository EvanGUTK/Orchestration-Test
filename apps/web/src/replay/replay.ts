import {
  LIMITS,
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  PRACTICE_RULESET_VERSION,
  REPLAY_SCHEMA_VERSION,
  RULESETS,
  SNAPSHOT_INTERVAL,
  practiceRuleset,
} from "@g2048/contracts";
import type { Direction, DomainEvent, GameState, ReplayFile, Ruleset } from "@g2048/contracts";
import type { ReplayData } from "../game/adapter.js";
import type { EnginePort } from "../game/engine-port.js";
import { tileDisplay } from "../lib/format.js";

/** Builds a portable ReplayFile for a local game; checksums come from the engine, never the UI. */
export function buildReplayFile(
  engine: EnginePort,
  data: ReplayData,
  meta: { displayName: string | null; createdAt: string },
): ReplayFile {
  const { final, checksums } = engine.replay(data.initial, data.moves, data.rules);
  return {
    replaySchemaVersion: REPLAY_SCHEMA_VERSION,
    engineVersion: data.initial.engineVersion,
    rulesetVersion: data.rules.version,
    seed: data.seed,
    initialState: data.initial,
    initialChecksum: engine.checksum(data.initial),
    moves: data.moves.map((direction, i) => ({
      revision: data.initial.revision + i + 1,
      direction,
      checksum: checksums[i] as string,
    })),
    finalChecksum: engine.checksum(final),
    meta: { mode: data.mode, displayName: meta.displayName, createdAt: meta.createdAt, source: "local" },
  };
}

export type ReplayProblemKind =
  | "too-large"
  | "not-json"
  | "not-replay"
  | "unsupported-version"
  | "unknown-ruleset"
  | "too-long"
  | "corrupt";

export type ReplayProblem = {
  readonly kind: ReplayProblemKind;
  readonly message: string;
  readonly atMove: number | null;
};

export type AnalyzedReplay = {
  readonly file: ReplayFile;
  readonly rules: Ruleset;
  readonly moves: readonly Direction[];
  /** snapshots[k] = state after k * SNAPSHOT_INTERVAL moves (snapshots[0] = initial state). */
  readonly snapshots: readonly GameState[];
  readonly final: GameState;
};

export type AnalyzeResult =
  | { readonly ok: true; readonly replay: AnalyzedReplay }
  | { readonly ok: false; readonly problem: ReplayProblem };

const problem = (kind: ReplayProblemKind, message: string, atMove: number | null = null): AnalyzeResult => ({
  ok: false,
  problem: { kind, message, atMove },
});

/** Candidate rulesets: built-ins by version; practice tries the default 4-weight first, then the rest. */
function candidateRules(file: Record<string, unknown>): Ruleset[] | null {
  const version = file.rulesetVersion;
  if (typeof version !== "string") return null;
  const builtin = (RULESETS as Record<string, Ruleset>)[version];
  if (builtin) return [builtin];
  if (version !== PRACTICE_RULESET_VERSION) return null;
  const size = (file.initialState as { board?: { size?: unknown } } | undefined)?.board?.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < MIN_BOARD_SIZE || size > MAX_BOARD_SIZE) {
    return null;
  }
  const weights = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return weights.map((fourWeight) => practiceRuleset({ size, fourWeight, undo: true }));
}

/**
 * Validates and prepares a replay for playback: size limit, JSON, schema/engine version, ruleset,
 * full verification with the engine (initial state = newGame(rules, seed), every move changes the board
 * and matches its revision + checksum, final checksum), then a snapshot every SNAPSHOT_INTERVAL moves so
 * seeking never replays more than SNAPSHOT_INTERVAL - 1 moves.
 */
export function analyzeReplayText(
  text: string,
  engine: EnginePort,
  byteLength = new Blob([text]).size,
): AnalyzeResult {
  if (byteLength > LIMITS.replayImportBytes) {
    return problem(
      "too-large",
      `This file is ${(byteLength / 1048576).toFixed(1)} MB; replay files are limited to ${LIMITS.replayImportBytes / 1048576} MB.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return problem("not-json", "This file isn't valid JSON, so it can't be a 2048 Infinite replay.");
  }
  return analyzeReplayValue(value, engine);
}

export function analyzeReplayValue(value: unknown, engine: EnginePort): AnalyzeResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("replaySchemaVersion" in value)
  ) {
    return problem("not-replay", "This JSON file isn't a 2048 Infinite replay (no replaySchemaVersion).");
  }
  const file = value as Record<string, unknown>;
  if (file.replaySchemaVersion !== REPLAY_SCHEMA_VERSION) {
    return problem(
      "unsupported-version",
      `Replay format version ${String(file.replaySchemaVersion)} isn't supported; this app reads version ${REPLAY_SCHEMA_VERSION}.`,
    );
  }
  if (Array.isArray(file.moves) && file.moves.length > LIMITS.replayMaxMoves) {
    return problem(
      "too-long",
      `This replay has ${file.moves.length.toLocaleString()} moves; the limit is ${LIMITS.replayMaxMoves.toLocaleString()}.`,
    );
  }
  const candidates = candidateRules(file);
  if (!candidates) {
    return problem(
      "unknown-ruleset",
      `Unknown ruleset "${String(file.rulesetVersion)}" — this replay can't be checked.`,
    );
  }

  let worst: { code: string; atMove: number | null; message: string } | null = null;
  for (const rules of candidates) {
    const result = engine.verifyReplay(file as unknown as ReplayFile, rules);
    if (result.ok)
      return { ok: true, replay: prepare(file as unknown as ReplayFile, rules, result.final, engine) };
    if (result.code === "REPLAY_VERSION_UNSUPPORTED") {
      return problem(
        "unsupported-version",
        `This replay was made by an unsupported engine or format: ${result.message}.`,
      );
    }
    if (result.code === "RESOURCE_LIMIT")
      return problem("too-long", `This replay exceeds a resource limit: ${result.message}.`);
    if (!worst || (result.atMove ?? -1) > (worst.atMove ?? -1)) worst = result;
  }
  const at = worst?.atMove ?? null;
  return problem(
    "corrupt",
    at === null
      ? `This replay failed verification: ${worst?.message ?? "unknown problem"}.`
      : `This replay is corrupt or was edited: move ${at + 1} doesn't match (${worst?.message}).`,
    at,
  );
}

function prepare(file: ReplayFile, rules: Ruleset, final: GameState, engine: EnginePort): AnalyzedReplay {
  const moves = file.moves.map((m) => m.direction);
  const snapshots: GameState[] = [file.initialState];
  let state = file.initialState;
  for (let i = 0; i < moves.length; i++) {
    state = engine.applyMove(state, moves[i] as Direction, rules).state;
    if ((i + 1) % SNAPSHOT_INTERVAL === 0) snapshots.push(state);
  }
  return { file, rules, moves, snapshots, final };
}

export type ReplayFrame = {
  readonly index: number;
  readonly state: GameState;
  /** Events of the move that produced this frame (empty at index 0). */
  readonly events: readonly DomainEvent[];
  readonly scoreDelta: string;
};

/**
 * Random access into a verified replay. Position i = state after i moves. Seeking starts from the
 * nearest snapshot at or before i; stepping forward reuses the current frame.
 */
export class ReplayCursor {
  private cache: ReplayFrame;

  constructor(
    private readonly engine: EnginePort,
    readonly replay: AnalyzedReplay,
  ) {
    this.cache = { index: 0, state: replay.file.initialState, events: [], scoreDelta: "0" };
  }

  get length(): number {
    return this.replay.moves.length;
  }

  frame(index: number): ReplayFrame {
    const target = Math.max(0, Math.min(this.length, Math.floor(index)));
    if (target === this.cache.index) return this.cache;
    let from: ReplayFrame;
    if (target > this.cache.index && target - this.cache.index < SNAPSHOT_INTERVAL) {
      from = this.cache;
    } else {
      // Start one move early so the target frame has its own events.
      const start = Math.max(0, target - 1);
      const k = Math.floor(start / SNAPSHOT_INTERVAL);
      from = {
        index: k * SNAPSHOT_INTERVAL,
        state: this.replay.snapshots[k] as GameState,
        events: [],
        scoreDelta: "0",
      };
    }
    let frame = from;
    while (frame.index < target) {
      const result = this.engine.applyMove(
        frame.state,
        this.replay.moves[frame.index] as Direction,
        this.replay.rules,
      );
      frame = {
        index: frame.index + 1,
        state: result.state,
        events: result.events,
        scoreDelta: result.scoreDelta,
      };
    }
    this.cache = frame;
    return frame;
  }
}

const cell = (index: number, size: number) =>
  `row ${Math.floor(index / size) + 1}, column ${(index % size) + 1}`;
const value = (exponent: string) => tileDisplay(exponent, "auto").ariaLabel;

/** Plain-language explanation of one move's events (merges, spawn, milestones, game over). */
export function explainEvents(events: readonly DomainEvent[], size: number): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "tile.merged") {
      const from = String(BigInt(e.exponent) - 1n);
      lines.push(
        `Two ${value(from)} tiles merged into ${value(e.exponent)} at ${cell(e.to, size)} (+${value(e.exponent)} points).`,
      );
    } else if (e.type === "tile.spawned") {
      lines.push(`A new ${value(e.exponent)} appeared at ${cell(e.at, size)}.`);
    } else if (e.type === "milestone.reached") {
      lines.push(`Milestone: first ${value(e.exponent)} tile${e.first2048 ? " — 2048 reached!" : ""}.`);
    } else if (e.type === "game.over") {
      lines.push("No moves left: the game is over.");
    }
  }
  const moved = events.filter((e) => e.type === "tile.moved").length;
  if (moved > 0) lines.unshift(`${moved} tile${moved === 1 ? "" : "s"} slid.`);
  return lines;
}

export function replayFileName(file: ReplayFile): string {
  const date = file.meta.createdAt.slice(0, 10) || "replay";
  return `2048-infinite-replay-${file.rulesetVersion}-${date}-${file.moves.length}moves.json`;
}
