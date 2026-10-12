import { BOT_SEED_NAMESPACE, BOT_VERSION, DIRECTIONS, DomainError } from "@2048/contracts";
import type { Board, BotConfig, Direction } from "@2048/contracts";
import { createRng, deriveSeedWords, legalMoves } from "@2048/engine";
import { Budget, StopSearch } from "./budget.ts";
import { validateBotConfig } from "./config.ts";
import { legalDirectionIndexes, toGrid, directionAt } from "./sim.ts";
import { expectimaxStrategy, greedyStrategy, heuristicStrategy, randomStrategy } from "./strategies.ts";
import type { StrategyContext, StrategyPick } from "./strategies.ts";
import type { BotDecision, BotRng, ChooseMoveOptions } from "./types.ts";

/** Bot-private tie-break stream: derived from the bot seed (+ move index) in the BOT namespace, never from the game PRNG. */
export function createBotStream(seed: string, moveIndex?: number): BotRng {
  const material = moveIndex === undefined ? seed : `${seed}#${moveIndex}`;
  return createRng(deriveSeedWords(material, BOT_SEED_NAMESPACE));
}

function firstLegal(board: Board): Direction {
  const legal = legalMoves(board);
  const first = legal[0];
  if (first === undefined) throw new DomainError("NO_CHANGE", "no legal move: the board is dead");
  return first;
}

/**
 * Pick a move from the BOARD ONLY (cloned internally; the caller's board is never touched, the game PRNG is
 * unreachable). Always returns a legal move: budget exhaustion, cancellation, or an internal error falls back
 * to the best completed result or the first legal move. Throws NO_CHANGE for a dead board and
 * VALIDATION_ERROR for a malformed config/board.
 *
 * Node accounting: `nodes <= max(nodeBudget, legalMoveCount)` (the one-ply baseline is always completed).
 */
export function chooseMove(board: Board, rawConfig: BotConfig, options: ChooseMoveOptions = {}): BotDecision {
  const config = validateBotConfig(rawConfig);
  const { grid, n } = toGrid(board);
  const legalIdx = legalDirectionIndexes(grid, n);
  const base = { strategy: config.strategy, botVersion: BOT_VERSION } as const;
  if (legalIdx.length === 0) throw new DomainError("NO_CHANGE", "no legal move: the board is dead");

  if (options.signal?.aborted) {
    return { ...base, direction: directionAt(legalIdx[0]!), explanation: "cancelled before searching: first legal move", nodes: 0, stopReason: "cancelled", depthReached: 0 };
  }

  const now = options.now ?? (() => performance.now());
  const deadline = options.ignoreTimeBudget ? null : now() + config.timeBudgetMs;
  const budget = new Budget(config.nodeBudget, options.signal, deadline, now);
  const rng = options.rng ?? createBotStream(config.seed, options.moveIndex);
  const ctx: StrategyContext = { grid, n, legal: legalIdx, rng, budget, config, spawnFourTenths: options.spawnFourTenths ?? 1 };

  let pick: StrategyPick;
  try {
    switch (config.strategy) {
      case "random": pick = randomStrategy(ctx); break;
      case "greedy": pick = greedyStrategy(ctx); break;
      case "heuristic": pick = heuristicStrategy(ctx); break;
      case "expectimax": pick = expectimaxStrategy(ctx); break;
    }
  } catch (e) {
    if (e instanceof DomainError) throw e;
    const reason = e instanceof StopSearch ? e.reason : "fallback";
    pick = { dirIndex: legalIdx[0]!, explanation: `fell back to the first legal move (${e instanceof StopSearch ? e.reason : "internal error"})`, depthReached: 0, stopReason: reason };
  }

  // The engine is the authority on legality: never return a move it would not accept.
  const direction = DIRECTIONS[pick.dirIndex]!;
  if (!legalMoves(board).includes(direction)) {
    return { ...base, direction: firstLegal(board), explanation: "chosen move was not legal; substituted the first legal move", nodes: budget.nodes, stopReason: "fallback", depthReached: 0 };
  }
  return { ...base, direction, explanation: pick.explanation, nodes: budget.nodes, stopReason: pick.stopReason, depthReached: pick.depthReached };
}
