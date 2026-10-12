import { LIMITS, RULESETS } from "@g2048/contracts";
import type { BotConfig } from "@g2048/contracts";
import { createMatch, reduceMatch } from "@g2048/competition";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBotRng } from "../choose-move.js";
import { engineAdapter } from "../engine-adapter.js";
import { chooseMove } from "../index.js";
import { BotWorkerPool } from "./pool.js";
import type { BotDecisionInput } from "./pool.js";
import { createBotServices } from "./services.js";
import type { BotServices } from "./services.js";
import { stressBots } from "./stress.js";

const rules = RULESETS["duel-v1"];
const greedy: BotConfig = { strategy: "greedy-v1", nodeBudget: 4, timeBudgetMs: 1000 };
// Opening expectimax decision with a 5M budget searches ~2M nodes (~1.7 s) unless cancelled.
const heavy: BotConfig = { strategy: "expectimax-v1", nodeBudget: 5_000_000, timeBudgetMs: 10_000 };

function input(config: BotConfig, seed = "pool"): BotDecisionInput {
  return {
    state: engineAdapter.newGame(rules, seed),
    rules,
    config,
    botRng: deriveBotRng(engineAdapter, seed),
  };
}

const pools: { shutdown(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.shutdown()));
});
function pool(options?: ConstructorParameters<typeof BotWorkerPool>[0]): BotWorkerPool {
  const p = new BotWorkerPool(options);
  pools.push(p);
  return p;
}
function services(options?: Parameters<typeof createBotServices>[0]): BotServices {
  const s = createBotServices(options);
  pools.push(s);
  return s;
}

describe("BotWorkerPool", () => {
  it("validates its limits and defaults to LIMITS.concurrentBotRunsMax with 2 reserved seat slots", () => {
    const p = pool();
    expect(p.stats()).toMatchObject({ size: LIMITS.concurrentBotRunsMax, reservedSeatSlots: 2, workers: 0 });
    expect(() => new BotWorkerPool({ size: 9 })).toThrow();
    expect(() => new BotWorkerPool({ size: 2, reservedSeatSlots: 3 })).toThrow();
    expect(new BotWorkerPool({ size: 1 }).reservedSeatSlots).toBe(0);
  });

  it("a seat-only pool rejects lab jobs instead of queueing them forever", async () => {
    const p = pool({ size: 2, reservedSeatSlots: 2 });
    await expect(p.submit("lab", input(greedy)).promise).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns the same decision as the in-process chooseMove", async () => {
    const p = pool({ size: 1 });
    const req = input(greedy);
    const { result } = await p.submit("lab", req).promise;
    expect(result).toEqual(chooseMove(req.state, req.rules, req.config, req.botRng));
  }, 30_000);

  it("never lets lab jobs occupy the reserved seat slots", async () => {
    const p = pool({ size: 3, reservedSeatSlots: 2 });
    const lab = [0, 1, 2].map((i) => p.submit("lab", input(heavy, `lab-${i}`)));
    lab.forEach((t) => t.promise.catch(() => undefined));
    expect(p.stats()).toMatchObject({ busyLab: 1, queuedLab: 2 });
    // Seats get the reserved workers immediately even though lab work is queued.
    const t0 = performance.now();
    const seats = await Promise.all([
      p.submit("seat", input(greedy, "seat-1")).promise,
      p.submit("seat", input(greedy, "seat-2")).promise,
    ]);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(seats.every((s) => s.result.kind === "move")).toBe(true);
    expect(p.stats()).toMatchObject({ busyLab: 1, queuedLab: 2, workers: 3 });
    lab.forEach((t) => t.cancel());
    await Promise.all(lab.map((t) => expect(t.promise).rejects.toMatchObject({ code: "CANCELLED" })));
  }, 30_000);

  it("serves queued seat jobs before queued lab jobs", async () => {
    const p = pool({ size: 1, reservedSeatSlots: 0 });
    const order: string[] = [];
    const blocker = p.submit("lab", input(greedy, "blocker"));
    const lab = p.submit("lab", input(greedy, "lab"));
    const seat = p.submit("seat", input(greedy, "seat"));
    void lab.promise.then(() => order.push("lab"));
    void seat.promise.then(() => order.push("seat"));
    await Promise.all([blocker.promise, lab.promise, seat.promise]);
    expect(order).toEqual(["seat", "lab"]);
  }, 30_000);

  it("bounds each queue and cancels queued and running jobs", async () => {
    const p = pool({ size: 1, reservedSeatSlots: 0, labQueueMax: 1 });
    const running = p.submit("lab", input(heavy, "r"));
    const queued = p.submit("lab", input(greedy, "q"));
    const rejected = p.submit("lab", input(greedy, "x"));
    await expect(rejected.promise).rejects.toMatchObject({ code: "RUNNER_BUSY" });
    queued.cancel();
    await expect(queued.promise).rejects.toMatchObject({ code: "CANCELLED" });
    await new Promise((r) => setTimeout(r, 600));
    const t0 = performance.now();
    running.cancel();
    await expect(running.promise).rejects.toMatchObject({ code: "CANCELLED" });
    // The worker is freed by the aborted search and serves the next job.
    const next = await p.submit("lab", input(greedy, "n")).promise;
    expect(next.result.kind).toBe("move");
    expect(performance.now() - t0).toBeLessThan(1500);
  }, 30_000);
});

describe("createBotServices", () => {
  it("bot-lab runs and duel seats share one pool; seats are not starved by lab runs", async () => {
    const s = services({ size: 3, reservedSeatSlots: 1 });
    const runs = [0, 1, 2, 3].map((i) =>
      s.runner.start({ runId: `lab-${i}`, config: heavy, seed: `lab-${i}`, rules, maxMoves: 500 }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(s.pool.stats().busyLab).toBeLessThanOrEqual(2);
    expect(s.pool.stats().workers).toBeLessThanOrEqual(3);

    let m = createMatch({
      id: "m1",
      kind: "human-bot",
      season: "s1",
      creator: { kind: "human", accountId: "alice" },
    }).state;
    m = reduceMatch(m, {
      type: "join",
      participant: { kind: "bot", strategy: "greedy-v1", botVersion: "bots-1.1.0" },
    }).state;
    const t0 = performance.now();
    const action = await s.seats.decide({
      match: m,
      seat: "b",
      game: engineAdapter.newGame(rules, "seat"),
      rules,
      config: greedy,
      botRng: deriveBotRng(engineAdapter, "seat"),
    });
    expect(action.kind).toBe("move");
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(s.pool.stats().workers).toBeLessThanOrEqual(3);

    await s.shutdown();
    const results = await Promise.all(runs.map((r) => r.result));
    expect(results.every((r) => r.status === "cancelled")).toBe(true);
  }, 30_000);
});

describe("stressBots (OPS-06 hook)", () => {
  it("runs simultaneous hard bots and returns raw event-loop measurements", async () => {
    const result = await stressBots({
      games: 4,
      strategy: "expectimax-v1",
      budget: { nodeBudget: 200_000, timeBudgetMs: 150 },
      durationMs: 1500,
    });
    expect(result).toMatchObject({ strategy: "expectimax-v1", games: 4, requestedDurationMs: 1500 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1500);
    expect(result.slots).toHaveLength(4);
    for (const slot of result.slots) {
      expect(slot.moves).toBeGreaterThan(0);
      expect(slot.decisionLatencyMs.length).toBeGreaterThanOrEqual(slot.moves);
    }
    expect(result.lagSamplesMs.length).toBeGreaterThan(10);
    expect(result.eventLoopDelay.count).toBeGreaterThan(0);
    expect(Number.isFinite(result.eventLoopDelay.maxNs)).toBe(true);
    expect(Object.keys(result.eventLoopDelay.percentilesNs).length).toBeGreaterThan(0);
    // Searches run off-thread: the caller's loop stays responsive (loose bound; quality owns thresholds).
    expect(Math.max(...result.lagSamplesMs)).toBeLessThan(250);
  }, 30_000);

  it("validates its options", async () => {
    await expect(
      stressBots({ games: 9, budget: { nodeBudget: 10, timeBudgetMs: 10 }, durationMs: 10 }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      stressBots({ budget: { nodeBudget: 0, timeBudgetMs: 10 }, durationMs: 10 }),
    ).rejects.toThrow();
    await expect(
      stressBots({ budget: { nodeBudget: 10, timeBudgetMs: 10 }, durationMs: 0 }),
    ).rejects.toThrow();
  });
});
