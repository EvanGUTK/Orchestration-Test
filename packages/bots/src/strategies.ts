import { DIRECTIONS } from "@g2048/contracts";
import type { Board, BotStrategy, Direction, RandomState, Ruleset } from "@g2048/contracts";
import { SearchAborted } from "./budget.js";
import type { SearchBudget } from "./budget.js";
import type { EnginePort } from "./engine-port.js";
import { DEAD_BOARD_VALUE, emptyIndexes, evaluateBoard, placeTile } from "./evaluate.js";

/**
 * Strategy inputs are the public board, the public ruleset, and the bot's own RandomState.
 * No strategy ever sees GameState.rng or simulates the game's spawn stream: chance nodes
 * enumerate every empty cell with the public spawn weights instead.
 */
export type StrategyContext = {
  readonly port: EnginePort;
  readonly board: Board;
  readonly rules: Ruleset;
  /** Engine legalMoves(board), DIRECTIONS order, non-empty. */
  readonly legal: readonly Direction[];
  readonly rng: RandomState;
  readonly budget: SearchBudget;
};

export type StrategyChoice = {
  readonly direction: Direction;
  readonly rng: RandomState;
  readonly explanation: string;
};

/** May throw SearchAborted when the budget runs out before any answer exists. */
export type Strategy = (ctx: StrategyContext) => StrategyChoice;

export const HEURISTIC_MAX_DEPTH = 3;
export const EXPECTIMAX_MAX_DEPTH = 4;

/** Uniform tie-break on the bot stream; no draw when the choice is forced. */
function breakTie(port: EnginePort, rng: RandomState, tied: readonly Direction[]): [Direction, RandomState] {
  if (tied.length === 1) return [tied[0] as Direction, rng];
  const [i, next] = port.uniform(rng, tied.length);
  return [tied[i] as Direction, next];
}

const tieNote = (tied: readonly Direction[]): string =>
  tied.length > 1 ? `; tie between ${tied.join("/")} broken by bot RNG` : "";

/** random-v1: a uniformly random legal move drawn from the bot stream. */
export const randomStrategy: Strategy = ({ port, legal, rng, budget }) => {
  budget.tick();
  const [i, next] = port.uniform(rng, legal.length);
  const direction = legal[i] as Direction;
  return {
    direction,
    rng: next,
    explanation: `random-v1: picked ${direction} uniformly from ${legal.length} legal move(s)`,
  };
};

/** greedy-v1: the legal move with the largest exact immediate merge score. */
export const greedyStrategy: Strategy = ({ port, board, legal, rng, budget }) => {
  let best = -1n;
  let tied: Direction[] = [];
  for (const d of legal) {
    budget.tick();
    const gain = BigInt(port.slide(board, d).scoreDelta);
    if (gain > best) {
      best = gain;
      tied = [d];
    } else if (gain === best) {
      tied.push(d);
    }
  }
  const [direction, next] = breakTie(port, rng, tied);
  return {
    direction,
    rng: next,
    explanation:
      best === 0n
        ? `greedy-v1: no move merges, so ${direction}${tieNote(tied)}`
        : `greedy-v1: ${direction} merges for ${best} points${tieNote(tied)}`,
  };
};

type RootResult = { readonly tied: Direction[]; readonly value: number; readonly depth: number };

/** Iterative deepening; returns the last fully completed depth, rethrowing if none completed. */
function deepen(maxDepth: number, search: (depth: number) => RootResult): RootResult {
  let completed: RootResult | null = null;
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    try {
      completed = search(depth);
    } catch (error) {
      if (error instanceof SearchAborted && completed !== null) return completed;
      throw error;
    }
  }
  if (completed === null) throw new SearchAborted("node-budget");
  return completed;
}

function rootSearch(
  ctx: StrategyContext,
  depth: number,
  childValue: (child: Board, remaining: number) => number,
): RootResult {
  let best = Number.NEGATIVE_INFINITY;
  let tied: Direction[] = [];
  for (const d of ctx.legal) {
    ctx.budget.tick();
    const v = childValue(ctx.port.slide(ctx.board, d).board, depth - 1);
    if (v > best) {
      best = v;
      tied = [d];
    } else if (v === best) {
      tied.push(d);
    }
  }
  return { tied, value: best, depth };
}

/**
 * heuristic-v1: depth-limited max-only lookahead (iterative deepening to HEURISTIC_MAX_DEPTH
 * player moves within the budget) scored by evaluateBoard. Spawns are not modelled.
 */
export const heuristicStrategy: Strategy = (ctx) => {
  const { port, budget } = ctx;
  const value = (board: Board, remaining: number): number => {
    if (remaining === 0) return evaluateBoard(board);
    let best = DEAD_BOARD_VALUE;
    for (const d of DIRECTIONS) {
      budget.tick();
      const s = port.slide(board, d);
      if (s.changed) best = Math.max(best, value(s.board, remaining - 1));
    }
    return best;
  };
  const result = deepen(HEURISTIC_MAX_DEPTH, (depth) => rootSearch(ctx, depth, value));
  const [direction, next] = breakTie(port, ctx.rng, result.tied);
  return {
    direction,
    rng: next,
    explanation:
      `heuristic-v1: ${direction} scores ${result.value} at lookahead depth ${result.depth} ` +
      `(empties, monotonicity, smoothness, corner)${tieNote(result.tied)}`,
  };
};

/**
 * expectimax-v1: bounded expectimax. Max nodes try every direction; chance nodes average over
 * every empty cell x {exponent 1 with p = 1 - fourWeight/10, exponent 2 with p = fourWeight/10}
 * (0.9 / 0.1 for the v1 rulesets). Iterative deepening to EXPECTIMAX_MAX_DEPTH player moves
 * within the budget; chance-node values are memoized per decision.
 */
export const expectimaxStrategy: Strategy = (ctx) => {
  const { port, budget, rules } = ctx;
  const pFour = rules.fourWeight / 10;
  const outcomes: [string, number][] = [];
  if (pFour < 1) outcomes.push(["1", 1 - pFour]);
  if (pFour > 0) outcomes.push(["2", pFour]);
  const memo = new Map<string, number>();

  const afterMove = (board: Board, remaining: number): number =>
    remaining === 0 ? evaluateBoard(board) : chance(board, remaining);

  const chance = (board: Board, remaining: number): number => {
    const empties = emptyIndexes(board);
    if (empties.length === 0) return max(board, remaining);
    const key = `${remaining}|${board.cells.join(",")}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let sum = 0;
    for (const index of empties) {
      for (const [exponent, p] of outcomes) {
        budget.tick();
        sum += p * max(placeTile(board, index, exponent), remaining);
      }
    }
    const v = sum / empties.length;
    memo.set(key, v);
    return v;
  };

  const max = (board: Board, remaining: number): number => {
    let best = DEAD_BOARD_VALUE;
    for (const d of DIRECTIONS) {
      budget.tick();
      const s = port.slide(board, d);
      if (s.changed) best = Math.max(best, afterMove(s.board, remaining - 1));
    }
    return best;
  };

  const result = deepen(EXPECTIMAX_MAX_DEPTH, (depth) => rootSearch(ctx, depth, afterMove));
  const [direction, next] = breakTie(port, ctx.rng, result.tied);
  return {
    direction,
    rng: next,
    explanation:
      `expectimax-v1: ${direction} has expected value ${result.value.toFixed(1)} ` +
      `at depth ${result.depth}${tieNote(result.tied)}`,
  };
};

export const STRATEGIES: Record<BotStrategy, Strategy> = {
  "random-v1": randomStrategy,
  "greedy-v1": greedyStrategy,
  "heuristic-v1": heuristicStrategy,
  "expectimax-v1": expectimaxStrategy,
};
