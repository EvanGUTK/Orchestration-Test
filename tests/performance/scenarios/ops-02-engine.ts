// OPS-02 | 100,000 pure 4x4 transitions — reproducible throughput; p95 < 2ms/move.
// Each sample times exactly one engine.applyMove call (performance.now(), sub-ms resolution); legal-move
// choice happens outside the timed region. Games are classic-v1, seeds "ops02-<run>-<k>", and the
// direction is a deterministic pick from legalMoves, so every timed transition is an accepted move.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RULESETS } from "@g2048/contracts";
import type { GameState } from "@g2048/contracts";
import { applyMove, checksum, legalMoves, newGame } from "@g2048/engine";
import { PERCENTILE_METHOD, check, summarize, threshold } from "../lib/report.js";
import type { Scenario } from "../lib/report.js";

const MOVES = Number(process.env.PERF_OPS02_MOVES ?? 100_000);
const WARMUP = 10_000;
const rules = RULESETS["classic-v1"];

function workload(label: string, moves: number, timed: boolean) {
  const samples: number[] = timed ? new Array<number>(moves) : [];
  const digest = createHash("sha256");
  let games = 0;
  let state: GameState = newGame(rules, `ops02-${label}-${games}`);
  let i = 0;
  const wall0 = performance.now();
  while (i < moves) {
    if (state.status !== "active") {
      digest.update(checksum(state));
      games += 1;
      state = newGame(rules, `ops02-${label}-${games}`);
      continue;
    }
    const legal = legalMoves(state.board);
    const d = legal[(i * 7 + games) % legal.length];
    if (!d) throw new Error("active game without a legal move");
    const t0 = performance.now();
    const r = applyMove(state, d, rules);
    const dt = performance.now() - t0;
    if (timed) samples[i] = dt;
    state = r.state;
    i += 1;
  }
  const wallMs = performance.now() - wall0;
  digest.update(checksum(state));
  return { samples, games: games + 1, digest: digest.digest("hex"), wallMs, finalChecksum: checksum(state) };
}

export const scenario: Scenario = {
  id: "OPS-02",
  title: "100,000 pure 4x4 applyMove transitions",
  async run() {
    workload("warmup", WARMUP, false);
    const a = workload("measured", MOVES, true);
    const b = workload("measured", MOVES, false); // same seeds/choices: must reproduce exactly
    const s = summarize(a.samples);
    const timedTotal = a.samples.reduce((x, y) => x + y, 0);
    return {
      id: "OPS-02",
      title: this.title,
      kind: MOVES === 100_000 ? "result" : "smoke",
      dataset: `${MOVES} accepted classic-v1 4x4 moves over ${a.games} seeded games (seeds ops02-measured-<k>), deterministic legal-move choice`,
      warmup: `${WARMUP} untimed transitions on seeds ops02-warmup-<k>`,
      rawSampleCount: s.count,
      percentileMethod: PERCENTILE_METHOD,
      metrics: {
        perMoveMs: s,
        throughputMovesPerSecTimedOnly: Math.round(MOVES / (timedTotal / 1000)),
        throughputMovesPerSecWallClock: Math.round(MOVES / (a.wallMs / 1000)),
        wallClockMs: Math.round(a.wallMs),
        games: a.games,
        runDigest: a.digest,
      },
      thresholds: [threshold("p95 per move", "< 2 ms", s.p95, s.p95 < 2)],
      correctness: [
        check(
          "reproducible: second run with the same seeds ends in the same state",
          a.digest === b.digest && a.finalChecksum === b.finalChecksum,
          `run digests ${a.digest.slice(0, 16)}… vs ${b.digest.slice(0, 16)}…; final checksum ${a.finalChecksum.slice(0, 16)}…`,
        ),
        check("every timed transition was an accepted move", s.count === MOVES, `${s.count} samples`),
      ],
      notMeasured: [],
      notes: [
        "Timer: performance.now() (monotonic, sub-millisecond); per-call timing includes ~0.1-1 µs timer overhead.",
      ],
    };
  },
};
