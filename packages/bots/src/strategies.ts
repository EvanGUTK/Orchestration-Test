import type { BotConfig } from "@2048/contracts";
import { Budget, StopSearch } from "./budget.ts";
import { DEAD_VALUE, evaluate } from "./evaluate.ts";
import { directionAt, emptyCount, newStats, slide } from "./sim.ts";
import type { Grid } from "./sim.ts";
import { effectiveDepth } from "./config.ts";
import type { BotRng, BotStopReason } from "./types.ts";

export type StrategyContext = {
  grid: Grid;
  n: number;
  /** Legal direction indexes, engine order. Never empty. */
  legal: number[];
  rng: BotRng;
  budget: Budget;
  config: BotConfig;
  spawnFourTenths: number;
};

export type StrategyPick = { dirIndex: number; explanation: string; depthReached: number; stopReason: BotStopReason };

function pickTie<T>(candidates: T[], rng: BotRng): T {
  return candidates.length === 1 ? candidates[0]! : candidates[rng.below(candidates.length)]!;
}

export function randomStrategy(ctx: StrategyContext): StrategyPick {
  for (let i = 0; i < ctx.legal.length; i++) ctx.budget.free();
  const dirIndex = ctx.legal[ctx.rng.below(ctx.legal.length)]!;
  return { dirIndex, explanation: `random: picked ${directionAt(dirIndex)} uniformly from ${ctx.legal.length} legal moves`, depthReached: 0, stopReason: "complete" };
}

/** Exact immediate score gain (BigInt) of one slide from its merged exponents. */
function gainOf(merged: Int32Array, count: number): bigint {
  let g = 0n;
  for (let i = 0; i < count; i++) g += 1n << BigInt(merged[i]!);
  return g;
}

export function greedyStrategy(ctx: StrategyContext): StrategyPick {
  const { grid, n } = ctx;
  const stats = newStats(n);
  const out: Grid = new Int32Array(grid.length);
  let bestGain = -1n;
  let bestEmpty = -1;
  let ties: number[] = [];
  for (const d of ctx.legal) {
    ctx.budget.free();
    slide(grid, out, n, d, stats);
    const gain = gainOf(stats.merged, stats.mergedCount);
    const empty = emptyCount(out);
    if (gain > bestGain || (gain === bestGain && empty > bestEmpty)) {
      bestGain = gain;
      bestEmpty = empty;
      ties = [d];
    } else if (gain === bestGain && empty === bestEmpty) {
      ties.push(d);
    }
  }
  const dirIndex = pickTie(ties, ctx.rng);
  return { dirIndex, explanation: `greedy: ${directionAt(dirIndex)} scores ${bestGain} now and leaves ${bestEmpty} empty cells`, depthReached: 1, stopReason: "complete" };
}

type Bufs = { get(level: number): Grid };
function makeBufs(size: number): Bufs {
  const pool: Grid[] = [];
  return {
    get(level: number): Grid {
      let g = pool[level];
      if (!g) {
        g = new Int32Array(size);
        pool[level] = g;
      }
      return g;
    },
  };
}

type Scored = { dirIndex: number; value: number }[];

/** Choose the best-scored root move, tie-breaking with the bot stream. */
function selectBest(scored: Scored, rng: BotRng): { dirIndex: number; value: number } {
  let best = -Infinity;
  for (const s of scored) if (s.value > best) best = s.value;
  const ties = scored.filter((s) => s.value === best);
  return pickTie(ties, rng);
}

/** Iterative deepening driver: baseline = static eval of each child; deeper passes replace it only when fully completed. */
function iterativeDeepening(ctx: StrategyContext, maxDepth: number, name: string, valueOfRootMove: (child: Grid, depth: number, bufs: Bufs) => number): StrategyPick {
  const { grid, n, budget, legal } = ctx;
  const bufs = makeBufs(grid.length);
  const stats = newStats(n);
  const child = new Int32Array(grid.length);
  let scored: Scored = [];
  for (const d of legal) {
    budget.free();
    slide(grid, child, n, d, stats);
    scored.push({ dirIndex: d, value: evaluate(child, n) });
  }
  let depthReached = 0;
  let stopReason: BotStopReason = "complete";
  try {
    for (let depth = 1; depth <= maxDepth; depth++) {
      const pass: Scored = [];
      for (const d of legal) {
        budget.tick();
        slide(grid, child, n, d, stats);
        pass.push({ dirIndex: d, value: valueOfRootMove(child, depth, bufs) });
      }
      scored = pass;
      depthReached = depth;
    }
  } catch (e) {
    if (!(e instanceof StopSearch)) throw e;
    stopReason = e.reason;
  }
  const best = selectBest(scored, ctx.rng);
  const suffix = stopReason === "complete" ? "" : `, stopped early (${stopReason})`;
  return {
    dirIndex: best.dirIndex,
    explanation: `${name}: ${directionAt(best.dirIndex)} scored ${Math.round(best.value)} after ${depthReached}-ply lookahead, ${budget.nodes} nodes${suffix}`,
    depthReached,
    stopReason,
  };
}

/**
 * Heuristic search: depth-limited alpha-beta minimax with a pessimistic spawn (the opponent places a 2 in the
 * worst empty cell for us) and the static evaluation at the leaves. It sees the board and public rules only:
 * the worst case is assumed, the real next tile is never read.
 */
export function heuristicStrategy(ctx: StrategyContext): StrategyPick {
  const { n, budget } = ctx;
  const stats = newStats(n);

  const maxNode = (b: Grid, k: number, level: number, bufs: Bufs, alpha: number, beta: number): number => {
    if (k === 0) {
      budget.tick();
      return evaluate(b, n);
    }
    const out = bufs.get(level);
    let best = DEAD_VALUE;
    let any = false;
    for (let d = 0; d < 4; d++) {
      budget.tick();
      if (!slide(b, out, n, d, stats)) continue;
      any = true;
      const v = minNode(out, k, level + 1, bufs, Math.max(alpha, best), beta);
      if (v > best) best = v;
      if (best >= beta) break;
    }
    return any ? best : DEAD_VALUE;
  };

  const minNode = (b: Grid, k: number, level: number, bufs: Bufs, alpha: number, beta: number): number => {
    let worst = Infinity;
    let any = false;
    for (let i = 0; i < b.length; i++) {
      if (b[i] !== 0) continue;
      any = true;
      b[i] = 1;
      const v = maxNode(b, k - 1, level, bufs, alpha, Math.min(beta, worst));
      b[i] = 0;
      if (v < worst) worst = v;
      if (worst <= alpha) break;
    }
    return any ? worst : maxNode(b, k - 1, level, bufs, alpha, beta);
  };

  return iterativeDeepening(ctx, Math.max(1, effectiveDepth(ctx.config)), "heuristic search", (child, depth, bufs) =>
    minNode(child, depth, 1, bufs, -Infinity, Infinity),
  );
}

/** Bounded expectimax: max nodes over moves, chance nodes averaging over every (empty cell, 2|4) spawn. Sees the board and public rules only. */
export function expectimaxStrategy(ctx: StrategyContext): StrategyPick {
  const { n, budget } = ctx;
  const pFour = ctx.spawnFourTenths / 10;
  const spawns: [number, number][] = [];
  if (pFour < 1) spawns.push([1, 1 - pFour]);
  if (pFour > 0) spawns.push([2, pFour]);
  const stats = newStats(n);
  const cache = new Map<string, number>();
  const CACHE_CAP = 200_000;

  const maxNode = (b: Grid, k: number, level: number, bufs: Bufs): number => {
    if (k === 0) {
      budget.tick();
      return evaluate(b, n);
    }
    const out = bufs.get(level);
    let best = DEAD_VALUE;
    let any = false;
    for (let d = 0; d < 4; d++) {
      budget.tick();
      if (!slide(b, out, n, d, stats)) continue;
      any = true;
      const v = chanceNode(out, k, level + 1, bufs);
      if (v > best) best = v;
    }
    return any ? best : DEAD_VALUE;
  };

  const chanceNode = (b: Grid, k: number, level: number, bufs: Bufs): number => {
    const key = `${k}|${b.join(",")}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let empties = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 0) empties++;
    let value: number;
    if (empties === 0) {
      value = maxNode(b, k - 1, level, bufs);
    } else {
      let total = 0;
      for (let i = 0; i < b.length; i++) {
        if (b[i] !== 0) continue;
        for (const [exp, p] of spawns) {
          b[i] = exp;
          total += p * maxNode(b, k - 1, level, bufs);
        }
        b[i] = 0;
      }
      value = total / empties;
    }
    if (cache.size < CACHE_CAP) cache.set(key, value);
    return value;
  };

  return iterativeDeepening(ctx, Math.max(1, effectiveDepth(ctx.config)), "expectimax", (child, depth, bufs) => {
    cache.clear();
    return chanceNode(child, depth, 1, bufs);
  });
}
