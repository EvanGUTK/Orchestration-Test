/**
 * Bot-strength benchmark (NOT a vitest test: the name does not match *.test.ts).
 *
 *   node packages/bots/test/benchmark.ts [--games N] [--max-moves M] [--node-budget B] [--concurrency C] [--json]
 *
 * For each strategy it plays N seeded games on the official 4x4 duel rules (cap 500 accepted moves) with a
 * fixed node budget and time budgets IGNORED, so scores, tiles and node counts are reproducible bit for bit
 * (rerun and compare `resultsChecksum`). Wall-clock milliseconds are printed separately and are NOT reproducible.
 * Each game runs in a worker thread via startBotRun (up to C at once).
 */
import { sha256Hex } from "@2048/engine";
import { DUEL_RULES } from "@2048/contracts";
import type { BotConfig, BotStrategy } from "@2048/contracts";
import { BOT_STRATEGIES, BOT_VERSION, defaultBotConfig, startBotRun } from "../src/index.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isSafeInteger(v) || v < 1) throw new Error(`--${name} needs a positive integer`);
  return v;
}

const GAMES = arg("games", 20);
const MAX_MOVES = arg("max-moves", DUEL_RULES.moveCap ?? 500);
const NODE_BUDGET = arg("node-budget", 20_000);
const CONCURRENCY = arg("concurrency", 4);
const AS_JSON = process.argv.includes("--json");

type GameOut = { strategy: BotStrategy; index: number; score: bigint; maxExp: number; moves: number; nodes: number; status: string; ms: number };

async function runOne(strategy: BotStrategy, index: number): Promise<GameOut> {
  const config: BotConfig = { ...defaultBotConfig(strategy, "bench-bot"), nodeBudget: NODE_BUDGET };
  const t0 = performance.now();
  const res = await startBotRun({ config, rules: DUEL_RULES, gameSeed: `bench-game-${index}`, maxMoves: MAX_MOVES, ignoreTimeBudget: true }).done;
  if (res.status !== "finished") throw new Error(`${strategy} game ${index} ended ${res.status}: ${res.error ?? ""}`);
  return { strategy, index, score: BigInt(res.score), maxExp: Number(res.maxExponent), moves: res.movesPlayed, nodes: res.nodes, status: res.state!.status, ms: performance.now() - t0 };
}

async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  }));
  return out;
}

const jobs: (() => Promise<GameOut>)[] = [];
for (const strategy of BOT_STRATEGIES) for (let i = 0; i < GAMES; i++) jobs.push(() => runOne(strategy, i));
const wall0 = performance.now();
const games = await pool(jobs, CONCURRENCY);
const wallMs = performance.now() - wall0;

const tileName = (e: number): string => `2^${e}=${e <= 20 ? 2 ** e : "?"}`;
const rows = BOT_STRATEGIES.map((strategy) => {
  const g = games.filter((x) => x.strategy === strategy);
  const scores = g.map((x) => x.score).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sum = scores.reduce((a, b) => a + b, 0n);
  const totalMoves = g.reduce((a, x) => a + x.moves, 0);
  const totalNodes = g.reduce((a, x) => a + x.nodes, 0);
  const dist = new Map<number, number>();
  for (const x of g) dist.set(x.maxExp, (dist.get(x.maxExp) ?? 0) + 1);
  const tiles = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  return {
    strategy,
    games: g.length,
    meanScore: Number(sum * 100n / BigInt(g.length)) / 100,
    medianScore: Number(scores[Math.floor(scores.length / 2)]!),
    minScore: Number(scores[0]!),
    maxScore: Number(scores[scores.length - 1]!),
    meanMoves: totalMoves / g.length,
    reachedCap: g.filter((x) => x.moves >= MAX_MOVES).length,
    maxTile: Object.fromEntries(tiles.map(([e, c]) => [tileName(e), c])),
    nodesPerMove: totalNodes / totalMoves,
    msPerMove: g.reduce((a, x) => a + x.ms, 0) / totalMoves,
  };
});

const reproducible = rows.map((r) => ({ ...r, msPerMove: undefined }));
const resultsChecksum = sha256Hex(JSON.stringify({ BOT_VERSION, GAMES, MAX_MOVES, NODE_BUDGET, reproducible, games: games.map((x) => [x.strategy, x.index, x.score.toString(), x.maxExp, x.moves, x.nodes, x.status]) }));

if (AS_JSON) {
  console.log(JSON.stringify({ botVersion: BOT_VERSION, games: GAMES, maxMoves: MAX_MOVES, nodeBudget: NODE_BUDGET, rows, resultsChecksum, wallMs }, null, 2));
} else {
  console.log(`bots ${BOT_VERSION} | rules ${DUEL_RULES.version} 4x4 | ${GAMES} games/strategy (seeds bench-game-0..${GAMES - 1}) | cap ${MAX_MOVES} moves | node budget ${NODE_BUDGET} | time budget ignored`);
  console.log("");
  console.log("| strategy | games | mean score | median | min | max | mean moves | hit move cap | nodes/move | ms/move (not reproducible) |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of rows) {
    console.log(`| ${r.strategy} | ${r.games} | ${r.meanScore.toFixed(1)} | ${r.medianScore} | ${r.minScore} | ${r.maxScore} | ${r.meanMoves.toFixed(1)} | ${r.reachedCap}/${r.games} | ${r.nodesPerMove.toFixed(1)} | ${r.msPerMove.toFixed(2)} |`);
  }
  console.log("");
  console.log("Max tile reached (games per tile):");
  for (const r of rows) console.log(`- ${r.strategy}: ${Object.entries(r.maxTile).map(([k, v]) => `${k} x${v}`).join(", ")}`);
  console.log("");
  console.log(`resultsChecksum ${resultsChecksum}`);
  console.log(`total wall time ${(wallMs / 1000).toFixed(1)}s (concurrency ${CONCURRENCY})`);
}
