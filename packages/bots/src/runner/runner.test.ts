import { LIMITS, RULESETS } from "@g2048/contracts";
import type { BotConfig } from "@g2048/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { engineAdapter } from "../engine-adapter.js";
import { playBotGame } from "../play.js";
import { BotRunner, BotRunnerError } from "./runner.js";
import type { BotRunProgress } from "./runner.js";

const duel = RULESETS["duel-v1"];
const greedy: BotConfig = { strategy: "greedy-v1", nodeBudget: 4, timeBudgetMs: 1000 };
// A deliberately slow search: ~seconds per decision unless cancelled.
const heavy: BotConfig = { strategy: "expectimax-v1", nodeBudget: 5_000_000, timeBudgetMs: 10_000 };

const runners: BotRunner[] = [];
function makeRunner(maxConcurrent?: number): BotRunner {
  const runner = new BotRunner(maxConcurrent === undefined ? {} : { maxConcurrent });
  runners.push(runner);
  return runner;
}
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.shutdown()));
});

describe("BotRunner (worker_threads)", () => {
  it("defaults to LIMITS.concurrentBotRunsMax and rejects invalid limits", () => {
    expect(makeRunner().maxConcurrent).toBe(LIMITS.concurrentBotRunsMax);
    expect(() => new BotRunner({ maxConcurrent: 0 })).toThrow(BotRunnerError);
    expect(() => new BotRunner({ maxConcurrent: LIMITS.concurrentBotRunsMax + 1 })).toThrow(BotRunnerError);
  });

  it("plays a run in a worker, reports progress per move, and records metadata", async () => {
    const runner = makeRunner();
    const progress: BotRunProgress[] = [];
    const handle = runner.start(
      { runId: "r1", config: greedy, seed: "runner-seed", rules: duel, maxMoves: 40 },
      (p) => progress.push(p),
    );
    const result = await handle.result;
    expect(result).toMatchObject({
      runId: "r1",
      status: "finished",
      end: "max-moves",
      strategy: "greedy-v1",
      difficulty: "medium",
      botVersion: "bots-1.0.0",
      nodeBudget: 4,
      timeBudgetMs: 1000,
      seed: "runner-seed",
      botSeed: "runner-seed",
      rulesetVersion: "duel-v1",
      acceptedMoves: 40,
    });
    expect(progress.map((p) => p.moveIndex)).toEqual([...Array(40).keys()]);
    expect(result.decisionLatencyMs.max).toBeGreaterThanOrEqual(result.decisionLatencyMs.mean);
    // Same decisions as the in-process deterministic player.
    const local = playBotGame(engineAdapter, {
      rules: duel,
      config: greedy,
      seed: "runner-seed",
      maxMoves: 40,
    });
    expect(result.moves).toEqual(local.moves);
    expect(result.finalScore).toBe(local.finalScore);
    expect(handle.status).toBe("finished");
    expect(runner.activeRuns).toBe(0);
  }, 30_000);

  it("supports start-paused, step, pause and resume", async () => {
    const runner = makeRunner();
    const handle = runner.start({
      runId: "r2",
      config: greedy,
      seed: "step-seed",
      rules: duel,
      maxMoves: 10,
      startPaused: true,
    });
    const first = await handle.step();
    const second = await handle.step();
    expect(first?.moveIndex).toBe(0);
    expect(second?.moveIndex).toBe(1);
    expect(handle.status).toBe("paused");
    // Nothing advances while paused.
    await new Promise((r) => setTimeout(r, 100));
    expect(handle.status).toBe("paused");
    handle.resume();
    await expect(handle.step()).rejects.toMatchObject({ code: "NOT_PAUSED" });
    const result = await handle.result;
    expect(result.acceptedMoves).toBe(10);
    expect(await handle.step()).toBeNull();
  }, 30_000);

  it("cancel aborts an in-flight search promptly and never counts as a finished game", async () => {
    const runner = makeRunner();
    const handle = runner.start({ runId: "r3", config: heavy, seed: "slow", rules: duel, maxMoves: 500 });
    await new Promise((r) => setTimeout(r, 1500)); // worker started and is searching
    const t0 = performance.now();
    const result = await handle.cancel();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(result).toMatchObject({ status: "cancelled", end: "cancelled" });
    expect(handle.status).toBe("cancelled");
    expect(result.acceptedMoves).toBeLessThan(500);
  }, 30_000);

  it("a slow bot never blocks the caller's event loop", async () => {
    const runner = makeRunner();
    const handle = runner.start({ runId: "r4", config: heavy, seed: "busy", rules: duel, maxMoves: 500 });
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 10);
    await new Promise((r) => setTimeout(r, 2500));
    clearInterval(timer);
    await handle.cancel();
    expect(maxGap).toBeLessThan(250);
  }, 30_000);

  it("bounds concurrency with an explicit busy error and frees slots when runs end", async () => {
    const runner = makeRunner(2);
    const a = runner.start({ runId: "a", config: heavy, seed: "a", rules: duel, maxMoves: 500 });
    runner.start({ runId: "b", config: heavy, seed: "b", rules: duel, maxMoves: 500 });
    expect(() => runner.start({ runId: "c", config: greedy, seed: "c", rules: duel, maxMoves: 5 })).toThrow(
      expect.objectContaining({ code: "RUNNER_BUSY" }),
    );
    expect(() => runner.start({ runId: "a", config: greedy, seed: "a", rules: duel, maxMoves: 5 })).toThrow(
      expect.objectContaining({ code: "DUPLICATE_RUN" }),
    );
    await a.cancel();
    await Promise.resolve();
    expect(runner.activeRuns).toBe(1);
    const c = runner.start({ runId: "c", config: greedy, seed: "c", rules: duel, maxMoves: 5 });
    expect((await c.result).acceptedMoves).toBe(5);
  }, 30_000);

  it("validates run parameters", () => {
    const runner = makeRunner();
    expect(() => runner.start({ runId: "x", config: greedy, seed: "x", rules: duel, maxMoves: 0 })).toThrow(
      BotRunnerError,
    );
    expect(() =>
      runner.start({ runId: "y", config: { ...greedy, nodeBudget: 0 }, seed: "y", rules: duel, maxMoves: 5 }),
    ).toThrow();
    expect(runner.activeRuns).toBe(0);
  });
});
