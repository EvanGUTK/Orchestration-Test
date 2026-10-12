// Local micro-benchmark for ENGINE-001 (not part of the test suite).
// Run: node packages/engine/test/bench.ts [count]
import { CLASSIC_RULES } from "@2048/contracts";
import type { Direction, GameState } from "@2048/contracts";
import { applyMove, createRng, newGame } from "../src/index.ts";

const COUNT = Number(process.argv[2] ?? 100_000);
const DIRS: Direction[] = ["up", "right", "down", "left"];
const rng = createRng([0x1234abcd, 0x55aa55aa, 0x0f0f0f0f, 0x9e3779b9]);

function canMoveFast(state: GameState, d: Direction): boolean {
  return applyMove(state, d, CLASSIC_RULES).changed;
}

// warm-up
{
  let s = newGame(CLASSIC_RULES, "warm");
  for (let i = 0; i < 20_000; i++) {
    const r = applyMove(s, DIRS[i & 3] as Direction, CLASSIC_RULES);
    s = r.state.status === "active" ? r.state : newGame(CLASSIC_RULES, `warm${i}`);
  }
}

const samples = new Float64Array(COUNT);
let n = 0;
let games = 0;
let state = newGame(CLASSIC_RULES, `bench-${games}`);
let sink = 0;
while (n < COUNT) {
  // pick a direction that changes the board (selection is outside the timed region)
  let dir = DIRS[rng.below(4)] as Direction;
  for (let k = 0; k < 4 && !canMoveFast(state, dir); k++) dir = DIRS[(DIRS.indexOf(dir) + 1) & 3] as Direction;
  const t0 = performance.now();
  const r = applyMove(state, dir, CLASSIC_RULES);
  const t1 = performance.now();
  if (!r.changed) {
    state = newGame(CLASSIC_RULES, `bench-${++games}`);
    continue;
  }
  samples[n++] = t1 - t0;
  sink += r.state.revision;
  state = r.state.status === "active" ? r.state : newGame(CLASSIC_RULES, `bench-${++games}`);
}
const sorted = Float64Array.from(samples).sort();
const pct = (p: number) => (sorted[Math.min(COUNT - 1, Math.floor((p / 100) * COUNT))] as number).toFixed(5);
const total = samples.reduce((a, b) => a + b, 0);
console.log(
  JSON.stringify({
    transitions: COUNT, games: games + 1, sink,
    totalMs: Number(total.toFixed(2)), meanMs: Number((total / COUNT).toFixed(5)),
    p50Ms: Number(pct(50)), p95Ms: Number(pct(95)), p99Ms: Number(pct(99)), maxMs: Number(pct(100)),
    targetP95Ms: 2, pass: Number(pct(95)) < 2,
  }),
);
