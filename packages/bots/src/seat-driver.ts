import type {
  BotConfig,
  BotDecision,
  Direction,
  GameState,
  RandomState,
  Ruleset,
  SeatId,
} from "@g2048/contracts";
import type { MatchCommand, MatchState } from "@g2048/competition";
import { BotError, createChooseMove } from "./choose-move.js";
import type { ChooseMoveOptions } from "./choose-move.js";
import type { CancelSignal } from "./budget.js";
import { engineAdapter } from "./engine-adapter.js";
import type { EnginePort } from "./engine-port.js";

/**
 * Bot seats in human-vs-bot and bot-vs-bot matches (COMP-004).
 *
 * planBotSeat decides, without searching, what a bot seat needs next:
 *  - idle:     nothing to do (match not active, or this seat is already terminal);
 *  - terminal: the seat's game is finished; apply `command` (a seat-terminal MatchCommand)
 *              to the match reducer exactly once;
 *  - decide:   the seat needs a move; ask chooseMove (in-process) or the worker driver.
 * The bot never forfeits on its own and has no timeouts: wall-clock time alone never ends a
 * seat (PROJECT_SCOPE). Each seat plays its own game; one seat's state never gates the other.
 */
export type BotSeatPlan =
  | { readonly kind: "idle"; readonly reason: "match-not-active" | "seat-terminal" }
  | { readonly kind: "terminal"; readonly command: Extract<MatchCommand, { type: "seat-terminal" }> }
  | { readonly kind: "decide" };

export type BotSeatAction =
  | Exclude<BotSeatPlan, { kind: "decide" }>
  | {
      readonly kind: "move";
      readonly direction: Direction;
      readonly decision: BotDecision;
      readonly rng: RandomState;
    };

export function planBotSeat(
  match: MatchState,
  seat: SeatId,
  game: GameState,
  port: EnginePort = engineAdapter,
): BotSeatPlan {
  if (seat !== "a" && seat !== "b") throw new BotError("VALIDATION_ERROR", "seat must be a or b");
  const matchSeat = match.seats[seat];
  if (matchSeat.participant?.kind !== "bot") {
    throw new BotError("VALIDATION_ERROR", `seat ${seat} is not a bot seat`);
  }
  if (match.status !== "active") return { kind: "idle", reason: "match-not-active" };
  if (matchSeat.terminal !== null) return { kind: "idle", reason: "seat-terminal" };
  if (game.rulesetVersion !== match.rulesetVersion) {
    throw new BotError("VALIDATION_ERROR", "seat game ruleset does not match the match ruleset");
  }
  const capped = game.acceptedMoves >= match.moveCap;
  const dead = port.isGameOver(game.board);
  if (game.status === "active" && !capped && !dead) return { kind: "decide" };
  const reason = game.status === "forfeited" ? "forfeit" : capped ? "move-cap" : "dead-board";
  return {
    kind: "terminal",
    command: {
      type: "seat-terminal",
      seat,
      reason,
      score: game.score,
      maxExponent: port.maxExponent(game.board),
      acceptedMoves: game.acceptedMoves,
    },
  };
}

/** Synchronous plan + chooseMove (tests, tournaments, CLI). The server uses BotSeatDriver instead. */
export function nextBotSeatAction(
  input: {
    readonly match: MatchState;
    readonly seat: SeatId;
    readonly game: GameState;
    readonly rules: Ruleset;
    readonly config: BotConfig;
    readonly botRng: RandomState;
    readonly signal?: CancelSignal;
    readonly options?: ChooseMoveOptions;
  },
  port: EnginePort = engineAdapter,
): BotSeatAction {
  const plan = planBotSeat(input.match, input.seat, input.game, port);
  if (plan.kind !== "decide") return plan;
  const result = createChooseMove(port)(
    input.game,
    input.rules,
    input.config,
    input.botRng,
    input.signal,
    input.options,
  );
  if (result.kind === "no-legal-move") {
    // Unreachable for engine-produced states (a dead board is already "completed"); kept total.
    return {
      kind: "terminal",
      command: {
        type: "seat-terminal",
        seat: input.seat,
        reason: "dead-board",
        score: input.game.score,
        maxExponent: port.maxExponent(input.game.board),
        acceptedMoves: input.game.acceptedMoves,
      },
    };
  }
  return { kind: "move", direction: result.decision.direction, decision: result.decision, rng: result.rng };
}
