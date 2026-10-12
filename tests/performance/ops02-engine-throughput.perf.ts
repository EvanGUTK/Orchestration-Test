/**
 * OPS-02: 100,000 pure 4x4 transitions. Reports p50/p95/p99 per accepted transition, throughput, host.
 * Correctness gate (not traded for speed): the first CHECK_MOVES transitions of every run are verified
 * move-by-move against the independent oracle (state checksum equality), and every game must be
 * reproducible from its seed (re-run of the first game yields the same final checksum).
 */
import { describe, expect, it } from "vitest";
import { applyMove as oApply, newGame as oNew, checksum as oChecksum, CLASSIC, type Dir, type OState } from "../integration/oracle/game.ts";
import { OracleRng, deriveWords } from "../integration/oracle/prng.ts";
import { hr, ms, summarize, writeReport } from "./support/stats.ts";
import { loadSubject } from "./support/subject.ts";

const TOTAL = Number(process.env.OPS02_TRANSITIONS ?? 100_000);
const WARMUP = 5_000;
const CHECK_MOVES = 3_000;
const subject = await loadSubject();
if (subject === null) console.warn("OPS-02 SKIPPED: @2048/engine is not available in this checkout (not a pass)");

describe.skipIf(subject === null)("OPS-02 engine throughput", () => {
  it(`runs ${TOTAL} transitions with p95 < 2 ms and oracle-verified prefix`, () => {
    if (subject === null) return;
    const picker = new OracleRng(deriveWords("ops02-picker"));
    const samples: number[] = [];
    let games = 0;
    let transitions = 0;
    let verified = 0;
    let firstGameFinal = "";
    let firstGameMoves: Dir[] = [];
    const t0 = Date.now();

    const run = (seed: string, record: boolean) => {
      let st = subject!.newGame(CLASSIC, seed);
      let ost: OState | null = verified < CHECK_MOVES ? oNew(CLASSIC, seed).state : null;
      const moves: Dir[] = [];
      while (st.status === "active" && transitions < TOTAL + WARMUP) {
        const legal = subject!.legalMoves(st.board);
        expect(legal.length).toBeGreaterThan(0);
        const dir = legal[picker.below(legal.length)]!;
        const a = hr();
        const r = subject!.applyMove(st, dir, CLASSIC);
        const b = hr();
        expect(r.changed).toBe(true);
        st = r.state;
        transitions++;
        if (transitions > WARMUP) samples.push(ms(a, b));
        if (record) moves.push(dir);
        if (ost !== null && verified < CHECK_MOVES) {
          ost = oApply(ost, dir, CLASSIC).state;
          expect(subject!.checksum(st), `oracle divergence at verified move ${verified}`).toBe(oChecksum(ost));
          verified++;
        } else ost = null;
      }
      return { st, moves };
    };

    while (transitions < TOTAL + WARMUP) {
      const seed = `ops02-${games}`;
      const { st, moves } = run(seed, games === 0);
      if (games === 0) {
        firstGameFinal = subject.checksum(st);
        firstGameMoves = moves;
      }
      games++;
    }
    // reproducibility: replaying the first game's moves from the seed gives the same final checksum
    let rs = subject.newGame(CLASSIC, "ops02-0");
    for (const d of firstGameMoves) rs = subject.applyMove(rs, d, CLASSIC).state;
    expect(subject.checksum(rs)).toBe(firstGameFinal);

    const s = summarize(samples);
    const elapsedMs = Date.now() - t0;
    const file = writeReport("ops02-engine-throughput", {
      subject: subject.name,
      workload: "random legal moves on 4x4 classic-v1, restart on game over",
      transitionsMeasured: samples.length,
      warmupTransitions: WARMUP,
      games,
      oracleVerifiedTransitions: verified,
      wallMs: elapsedMs,
      transitionsPerSecond: Math.round(samples.length / (samples.reduce((a, b) => a + b, 0) / 1000)),
      ...s,
      target: "p95 < 2 ms/move",
    });
    console.log(`OPS-02 ${subject.name}: n=${s.count} p50=${s.p50Ms.toFixed(5)}ms p95=${s.p95Ms.toFixed(5)}ms p99=${s.p99Ms.toFixed(5)}ms report=${file}`);
    expect(verified).toBe(CHECK_MOVES);
    expect(s.p95Ms).toBeLessThan(2);
  });
});
