// OPS-06 | Four simultaneous hard bots plus an interactive game — input remains responsive;
// budgets/cancel honoured. Bots: stressBots (expectimax-v1 "expert", 4 worker threads) in THIS process,
// while an interactive guest game plays moves over HTTP against the production server (separate process,
// same machine). Cancel: a long BotRunner run is cancelled mid-search.
// (POST /bots/runs is BACKEND-004; server-hosted bots will be re-measured then.)
import { performance } from "node:perf_hooks";
import { practiceRuleset } from "@g2048/contracts";
import type { Direction, GameResponse, GameState, MoveResponse } from "@g2048/contracts";
import { legalMoves } from "@g2048/engine";
import { BotRunner, stressBots } from "@g2048/bots/runner";
import { Client } from "../../integration/helpers/http.js";
import { PERCENTILE_METHOD, check, sleep, summarize, threshold } from "../lib/report.js";
import type { Scenario } from "../lib/report.js";
import { privateDataDir, startProdServer } from "../lib/server.js";

const DURATION_MS = 30_000;
const BUDGET = { nodeBudget: 20_000, timeBudgetMs: 250 };
const THINK_MS = 50;
const ns2ms = (ns: number) => Math.round((ns / 1e6) * 1e4) / 1e4;

export const scenario: Scenario = {
  id: "OPS-06",
  title: "4 hard bots + interactive HTTP game (responsiveness, budgets, cancel)",
  async run() {
    const dataDir = privateDataDir("ops06");
    const server = await startProdServer(dataDir);
    try {
      const c = new Client({ port: server.port });
      const created = await c.post<GameResponse>("/games", {
        mode: "practice",
        practice: { size: 8, seed: "ops06-interactive", undo: false },
      });
      if (created.status !== 201) throw new Error(`create: ${created.status} ${created.text}`);
      const gameId = created.json.game.id;
      let state: GameState = created.json.state;
      // warm the interactive path (untimed)
      for (let i = 0; i < 20; i++) {
        const d = legalMoves(state.board)[i % legalMoves(state.board).length] as Direction;
        const r = await c.post<MoveResponse>(`/games/${gameId}/moves`, {
          commandId: `ops06-w-${i}`,
          expectedRevision: state.revision,
          direction: d,
        });
        state = r.json.state;
      }

      // baseline interactive latency with idle bots
      const baseline: number[] = [];
      let seq = 0;
      const interactive = async (until: number, sink: number[]) => {
        while (performance.now() < until && state.status === "active") {
          const legal = legalMoves(state.board);
          const d = legal[seq % legal.length] as Direction;
          const t0 = performance.now();
          const r = await c.post<MoveResponse>(`/games/${gameId}/moves`, {
            commandId: `ops06-m-${++seq}`,
            expectedRevision: state.revision,
            direction: d,
          });
          sink.push(performance.now() - t0);
          if (r.status !== 200) throw new Error(`interactive move ${r.status} ${r.text}`);
          state = r.json.state;
          await sleep(THINK_MS);
        }
      };
      await interactive(performance.now() + 5_000, baseline);

      const underLoad: number[] = [];
      const t0 = performance.now();
      const [stress] = await Promise.all([
        stressBots({
          games: 4,
          strategy: "expectimax-v1",
          budget: BUDGET,
          durationMs: DURATION_MS,
          seed: "ops06",
        }),
        interactive(t0 + DURATION_MS, underLoad),
      ]);

      // cancel honoured: a maximal-budget run cancelled mid-search
      const runner = new BotRunner();
      let cancelMs = Number.NaN;
      let cancelStatus = "unknown";
      try {
        const handle = runner.start({
          runId: "ops06-cancel",
          config: { strategy: "expectimax-v1", nodeBudget: 5_000_000, timeBudgetMs: 10_000 },
          seed: "ops06-cancel",
          rules: practiceRuleset({ size: 4, fourWeight: 1, undo: false }),
          maxMoves: 100_000,
        });
        await sleep(500);
        const c0 = performance.now();
        const res = await handle.cancel();
        cancelMs = performance.now() - c0;
        cancelStatus = res.status;
      } finally {
        await runner.shutdown();
      }

      const lag = summarize(stress.lagSamplesMs);
      const decisions = stress.slots.flatMap((s) => s.decisionLatencyMs);
      const dec = summarize(decisions);
      const base = summarize(baseline);
      const load = summarize(underLoad);
      const nodeViolations = stress.slots.filter(
        (s) => s.nodesSearched > s.decisionLatencyMs.length * BUDGET.nodeBudget,
      );
      const p = stress.eventLoopDelay.percentilesNs;
      const pick = (q: number) => {
        const keys = Object.keys(p)
          .map(Number)
          .sort((a, b) => a - b);
        const k = keys.find((x) => x >= q) ?? keys.at(-1);
        return k === undefined ? null : ns2ms(p[String(k)] as number);
      };
      return {
        id: "OPS-06",
        title: this.title,
        kind: "partial",
        dataset: `4 x expectimax-v1 (budget ${BUDGET.nodeBudget} nodes / ${BUDGET.timeBudgetMs} ms) for ${DURATION_MS} ms on duel-v1 seeds ops06-<slot>-<n>; interactive 8x8 practice guest game (seed ops06-interactive) with ${THINK_MS} ms think time`,
        warmup: "20 untimed interactive moves; 5 s idle-bot baseline measured separately",
        rawSampleCount: load.count,
        percentileMethod: PERCENTILE_METHOD,
        metrics: {
          interactiveMoveMsIdleBots: base,
          interactiveMoveMsUnderBotLoad: load,
          botDecisionLatencyMs: dec,
          botMoves: stress.slots.reduce((x, s) => x + s.moves, 0),
          botNodesSearched: stress.slots.reduce((x, s) => x + s.nodesSearched, 0),
          botFallbackMoves: stress.slots.reduce((x, s) => x + s.fallbacks, 0),
          eventLoopDelayHistogramMs: {
            source:
              "perf_hooks.monitorEventLoopDelay (resolution 10 ms) on the thread orchestrating the bot pool + HTTP client",
            count: stress.eventLoopDelay.count,
            min: ns2ms(stress.eventLoopDelay.minNs),
            mean: ns2ms(stress.eventLoopDelay.meanNs),
            p50: pick(50),
            p90: pick(90),
            p99: pick(99),
            max: ns2ms(stress.eventLoopDelay.maxNs),
            rawPercentilesNs: p,
          },
          setIntervalLagMs: lag,
          cancel: { latencyMs: Math.round(cancelMs * 100) / 100, status: cancelStatus },
          elapsedMs: Math.round(stress.elapsedMs),
        },
        thresholds: [
          threshold(
            "p95 interactive move under bot load",
            "< 100 ms (QA target, same as OPS-03)",
            load.p95,
            load.p95 < 100,
          ),
          threshold("event-loop delay p99", "< 50 ms (QA target)", pick(99), (pick(99) ?? Infinity) < 50),
          threshold("cancel latency", "< 500 ms (QA target)", Math.round(cancelMs), cancelMs < 500),
        ],
        correctness: [
          check(
            "bots made progress",
            stress.slots.every((s) => s.moves > 0),
            stress.slots.map((s) => s.moves).join(","),
          ),
          check(
            "node budget honoured (nodes <= decisions x nodeBudget per slot)",
            nodeViolations.length === 0,
            stress.slots
              .map((s) => `${s.nodesSearched}/${s.decisionLatencyMs.length * BUDGET.nodeBudget}`)
              .join(", "),
          ),
          check(
            "time budget honoured (max decision round trip <= timeBudget + 250 ms)",
            dec.max <= BUDGET.timeBudgetMs + 250,
            `max ${dec.max} ms`,
          ),
          check("cancel honoured (run ends as cancelled)", cancelStatus === "cancelled", cancelStatus),
          check("interactive game kept accepting moves under load", load.count > 0, `${load.count} moves`),
        ],
        notMeasured: [
          "Server-hosted bot runs (POST /bots/runs, BACKEND-004): bots here run in the measuring process, the server is a separate process",
          "No-future-RNG access is BOT-03 (bots package tests), not re-measured here",
        ],
        notes: [
          "Thresholds marked 'QA target': ACCEPTANCE OPS-06 says 'input remains responsive' without a number.",
        ],
      };
    } finally {
      await server.stop();
    }
  },
};
