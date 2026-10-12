import { BOT_VERSION, DomainError } from "@2048/contracts";
import type { BotConfig, Decimal, Direction, Exponent, GameState, Ruleset } from "@2048/contracts";
import { applyMove, legalMoves, newGame, stateChecksum } from "@2048/engine";
import { chooseMove } from "./choose.ts";
import { describeBot } from "./config.ts";
import type { AbortSignalLike, BotMetadata, BotStopReason } from "./types.ts";

export type BotGameOptions = {
  rules: Ruleset;
  /** Seed of the GAME (engine PRNG). The bot's own stream comes from config.seed. */
  gameSeed: string;
  config: BotConfig;
  /** Stop after this many accepted moves even if the game continues (default: the ruleset cap, else unlimited). */
  maxMoves?: number;
  /** Deterministic mode: ignore config.timeBudgetMs and bound search by node budget only. */
  ignoreTimeBudget?: boolean;
  signal?: AbortSignalLike;
};

export type BotMoveRecord = {
  /** 1-based accepted move number. */
  sequence: number;
  direction: Direction;
  explanation: string;
  nodes: number;
  stopReason: BotStopReason;
  score: Decimal;
  maxExponent: Exponent;
  checksum: string;
  status: GameState["status"];
};

export function maxExponentOf(state: GameState): Exponent {
  let best = 0n;
  for (const c of state.board.cells) if (c !== null) { const v = BigInt(c); if (v > best) best = v; }
  return best.toString();
}

/** Plays one bot game one move at a time; shared by the worker thread, the tournament and tests. */
export class BotGame {
  readonly options: BotGameOptions;
  readonly metadata: BotMetadata;
  state: GameState;
  readonly moves: Direction[] = [];
  totalNodes = 0;
  last: BotMoveRecord | null = null;
  private readonly cap: number | null;

  constructor(options: BotGameOptions) {
    this.options = options;
    this.metadata = describeBot(options.config);
    this.state = newGame(options.rules, options.gameSeed);
    this.cap = options.maxMoves ?? options.rules.moveCap;
  }

  get finished(): boolean {
    return this.state.status !== "active" || (this.cap !== null && this.moves.length >= this.cap);
  }

  /** Play one move. Returns null when the game is already finished. */
  step(): BotMoveRecord | null {
    if (this.finished) return null;
    const { rules, config, ignoreTimeBudget, signal } = this.options;
    const decision = chooseMove(structuredClone(this.state.board), config, {
      moveIndex: this.moves.length,
      spawnFourTenths: rules.spawnFourTenths,
      ignoreTimeBudget,
      signal,
    });
    // A cancelled search yields a fallback move; do not apply it: cancellation ends the run before the move.
    if (decision.stopReason === "cancelled" && signal?.aborted) return null;
    let result = applyMove(this.state, decision.direction, rules);
    let direction = decision.direction;
    if (!result.changed) {
      // chooseMove already verified legality; this guards against engine/bot disagreement.
      const alt = legalMoves(this.state.board)[0];
      if (alt === undefined) throw new DomainError("NO_CHANGE", "bot has no legal move");
      direction = alt;
      result = applyMove(this.state, alt, rules);
    }
    this.state = result.state;
    this.moves.push(direction);
    this.totalNodes += decision.nodes;
    this.last = {
      sequence: this.moves.length,
      direction,
      explanation: decision.explanation,
      nodes: decision.nodes,
      stopReason: decision.stopReason,
      score: this.state.score,
      maxExponent: maxExponentOf(this.state),
      checksum: stateChecksum(this.state),
      status: this.state.status,
    };
    return this.last;
  }

  /** Play to completion (or until the signal aborts between moves). */
  runToEnd(onMove?: (r: BotMoveRecord) => void): void {
    while (!this.finished && !this.options.signal?.aborted) {
      const r = this.step();
      if (r && onMove) onMove(r);
    }
  }
}

export { BOT_VERSION };
