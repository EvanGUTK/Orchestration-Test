// OPS-07 | One-hour replay/bot soak after warmup — report RSS baseline/end/peak; < 25% sustained growth
// after equivalent workload. Duration: PERF_SOAK_MS (default 120000 = 2-minute SMOKE, reported as kind
// "smoke" and NOT judged). A run >= 3,600,000 ms is reported as the OPS-07 result.
// Repeated identical workload cycles: (a) engine build + full replay of a 2,000-move 8x8 game with checksum
// verification, (b) one BotRunner run (greedy-v1, 40 moves), (c) 10 authoritative HTTP moves on the
// production server. RSS sampled every 2 s for this process (process.memoryUsage) and the server process
// (Windows tasklist working set / Linux /proc VmRSS).
import { performance } from "node:perf_hooks";
import { practiceRuleset } from "@g2048/contracts";
import type { Direction, GameResponse, GameState, MoveResponse } from "@g2048/contracts";
import { applyMove, checksum, legalMoves, newGame } from "@g2048/engine";
import { BotRunner } from "@g2048/bots/runner";
import { Client } from "../../integration/helpers/http.js";
import { PERCENTILE_METHOD, check, threshold } from "../lib/report.js";
import type { Scenario } from "../lib/report.js";
import { privateDataDir, processRss, startProdServer } from "../lib/server.js";

const DURATION_MS = Number(process.env.PERF_SOAK_MS ?? 120_000);
const FULL_MS = 3_600_000;
const SAMPLE_MS = 2_000;
const rules8 = practiceRuleset({ size: 8, fourWeight: 1, undo: false });
const ORDER: Direction[] = ["down", "left", "right", "up"];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : Number.NaN;
};
const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;

export const scenario: Scenario = {
  id: "OPS-07",
  title: `replay/bot soak (${Math.round(DURATION_MS / 1000)} s)`,
  async run() {
    const isFull = DURATION_MS >= FULL_MS;
    const warmupMs = Math.max(10_000, Math.round(DURATION_MS * 0.1));
    const dataDir = privateDataDir("ops07");
    const server = await startProdServer(dataDir);
    const runner = new BotRunner();
    const samples: { tMs: number; selfRss: number; serverRss: number | null; heapUsed: number }[] = [];
    let cycles = 0;
    let replayMismatches = 0;
    let botFailures = 0;
    let httpErrors = 0;
    const httpErrorSamples: string[] = [];
    const noteErr = (s: string) => {
      httpErrors += 1;
      if (httpErrorSamples.length < 5) httpErrorSamples.push(s.slice(0, 300));
    };
    let seq = 0;
    const t0 = performance.now();
    const sampler = setInterval(() => {
      samples.push({
        tMs: Math.round(performance.now() - t0),
        selfRss: process.memoryUsage().rss,
        serverRss: processRss(server.pid),
        heapUsed: process.memoryUsage().heapUsed,
      });
    }, SAMPLE_MS);
    try {
      const c = new Client({ port: server.port });
      let game: { id: string; state: GameState } | null = null;
      while (performance.now() - t0 < DURATION_MS) {
        // (a) replay
        let s = newGame(rules8, `ops07-replay-${cycles % 5}`);
        const dirs: Direction[] = [];
        const sums: string[] = [];
        for (let i = 0; i < 2_000 && s.status === "active"; i++) {
          const legal = legalMoves(s.board);
          const d = ORDER.find((x) => legal.includes(x)) as Direction;
          s = applyMove(s, d, rules8).state;
          dirs.push(d);
          sums.push(checksum(s));
        }
        let r = newGame(rules8, `ops07-replay-${cycles % 5}`);
        for (const [i, d] of dirs.entries()) {
          r = applyMove(r, d, rules8).state;
          if (checksum(r) !== sums[i]) replayMismatches += 1;
        }
        // (b) bot run
        const res = await runner.start({
          runId: `ops07-bot-${cycles}`,
          config: { strategy: "greedy-v1", nodeBudget: 2_000, timeBudgetMs: 1_000 },
          seed: `ops07-bot-${cycles % 5}`,
          rules: practiceRuleset({ size: 4, fourWeight: 1, undo: false }),
          maxMoves: 40,
        }).result;
        if (res.status !== "finished") botFailures += 1;
        // (c) HTTP moves
        for (let i = 0; i < 10; i++) {
          if (!game || game.state.status !== "active") {
            const g = await c.post<GameResponse>("/games", {
              mode: "practice",
              practice: { size: 8, seed: `ops07-http-${cycles}`, undo: false },
            });
            if (g.status !== 201) {
              noteErr(`create ${g.status} ${g.text}`);
              break;
            }
            game = { id: g.json.game.id, state: g.json.state };
          }
          const legal = legalMoves(game.state.board);
          const m = await c.post<MoveResponse>(`/games/${game.id}/moves`, {
            commandId: `ops07-cmd-${String(++seq).padStart(6, "0")}`,
            expectedRevision: game.state.revision,
            direction: legal[seq % legal.length] as Direction,
          });
          if (m.status !== 200) noteErr(`move ${m.status} ${m.text}`);
          else game.state = m.json.state;
        }
        cycles += 1;
      }
    } finally {
      clearInterval(sampler);
      await runner.shutdown();
      await server.stop();
    }

    const post = samples.filter((s) => s.tMs >= warmupMs);
    const windowN = Math.max(3, Math.floor(post.length * 0.1));
    const baseWin = post.slice(0, windowN);
    const endWin = post.slice(-windowN);
    const series = (k: "selfRss" | "serverRss") => {
      const vals = (w: typeof post) => w.map((s) => s[k]).filter((x): x is number => typeof x === "number");
      const base = median(vals(baseWin));
      const end = median(vals(endWin));
      const peak = Math.max(...vals(post));
      return {
        baselineMB: mb(base),
        endMB: mb(end),
        peakMB: mb(peak),
        growthPct: Math.round(((end - base) / base) * 1000) / 10,
      };
    };
    const self = series("selfRss");
    const srv = samples.some((s) => s.serverRss !== null) ? series("serverRss") : null;
    const judged = (g: number) => (isFull ? g < 25 : null);
    return {
      id: "OPS-07",
      title: this.title,
      kind: isFull ? "result" : "smoke",
      dataset: `${cycles} identical-shape workload cycles (2,000-move 8x8 replay + greedy-v1 bot run of 40 moves + 10 HTTP moves)`,
      warmup: `first ${warmupMs} ms excluded; baseline = median of the first ${windowN} post-warmup samples, end = median of the last ${windowN}`,
      rawSampleCount: samples.length,
      percentileMethod: `${PERCENTILE_METHOD}; RSS windows use the lower median`,
      metrics: {
        durationMs: DURATION_MS,
        sampleIntervalMs: SAMPLE_MS,
        measuringProcessRss: self,
        serverProcessRss: srv ?? "not measurable on this platform",
        rawSamples: samples.map((s) => ({
          ...s,
          selfRssMB: mb(s.selfRss),
          serverRssMB: s.serverRss === null ? null : mb(s.serverRss),
        })),
      },
      thresholds: [
        threshold(
          "measuring process RSS growth",
          "< 25 %",
          self.growthPct,
          judged(self.growthPct),
          isFull ? undefined : "SMOKE run: indicative only, not the OPS-07 result",
        ),
        threshold(
          "server process RSS growth",
          "< 25 %",
          srv?.growthPct ?? null,
          srv ? judged(srv.growthPct) : null,
          isFull ? undefined : "SMOKE run: indicative only, not the OPS-07 result",
        ),
      ],
      correctness: [
        check("workload ran", cycles > 0, `${cycles} cycles`),
        check(
          "every replay reproduced its checksums",
          replayMismatches === 0,
          `${replayMismatches} mismatches`,
        ),
        check("every bot run finished", botFailures === 0, `${botFailures} failures`),
        check(
          "every HTTP move accepted",
          httpErrors === 0,
          `${httpErrors} errors ${JSON.stringify(httpErrorSamples)}`,
        ),
      ],
      notMeasured: isFull
        ? []
        : ["The one-hour OPS-07 measurement itself (scheduled by chief at M6; set PERF_SOAK_MS=3600000)"],
      notes: ["Windows server RSS = tasklist 'Mem Usage' (working set)."],
    };
  },
};
