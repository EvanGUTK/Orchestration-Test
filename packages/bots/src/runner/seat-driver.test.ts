import { LIMITS, RULESETS } from "@g2048/contracts";
import type { BotConfig, SeatId } from "@g2048/contracts";
import { createMatch, reduceMatch } from "@g2048/competition";
import type { MatchState, Participant } from "@g2048/competition";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBotRng } from "../choose-move.js";
import { engineAdapter } from "../engine-adapter.js";
import { nextBotSeatAction } from "../seat-driver.js";
import { BotSeatDriver } from "./seat-driver.js";
import type { BotSeatRequest } from "./seat-driver.js";

const rules = RULESETS["duel-v1"];
const bot = (strategy: "greedy-v1" | "expectimax-v1"): Participant => ({
  kind: "bot",
  strategy,
  botVersion: "bots-1.1.0",
});
const greedy: BotConfig = { strategy: "greedy-v1", nodeBudget: 4, timeBudgetMs: 1000 };
// A deliberately slow search: the opening decision searches ~2M nodes to depth 6 (~1.7 s).
const heavy: BotConfig = { strategy: "expectimax-v1", nodeBudget: 5_000_000, timeBudgetMs: 10_000 };

function match(id: string): MatchState {
  const m = createMatch({ id, kind: "bot-bot", season: "s1", creator: bot("expectimax-v1") }).state;
  return reduceMatch(m, { type: "join", participant: bot("greedy-v1") }).state;
}

function request(m: MatchState, seat: SeatId, config: BotConfig, seed = "seat-seed"): BotSeatRequest {
  return {
    match: m,
    seat,
    game: engineAdapter.newGame(rules, seed),
    rules,
    config,
    botRng: deriveBotRng(engineAdapter, seed),
  };
}

const drivers: BotSeatDriver[] = [];
function makeDriver(options?: ConstructorParameters<typeof BotSeatDriver>[0]): BotSeatDriver {
  const d = new BotSeatDriver(options);
  drivers.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((d) => d.shutdown()));
});

describe("BotSeatDriver (worker pool)", () => {
  it("defaults to a pool of LIMITS.concurrentBotRunsMax workers", () => {
    expect(makeDriver().pool.size).toBe(LIMITS.concurrentBotRunsMax);
    expect(() => new BotSeatDriver({ poolOptions: { size: 0 } })).toThrow();
  });

  it("decides off-thread with the same result as the pure seat driver", async () => {
    const driver = makeDriver({ poolOptions: { size: 2 } });
    const req = request(match("m1"), "b", greedy);
    const action = await driver.decide(req);
    expect(action).toEqual(nextBotSeatAction(req));
    expect(driver.pending).toBe(0);
  }, 30_000);

  it("answers terminal/idle plans without touching a worker", async () => {
    const driver = makeDriver({ poolOptions: { size: 1 } });
    const m = match("m2");
    const req = request(m, "a", greedy);
    const done = { ...req, game: { ...req.game, status: "forfeited" as const } };
    await expect(driver.decide(done)).resolves.toMatchObject({
      kind: "terminal",
      command: { reason: "forfeit" },
    });
    const ended = reduceMatch(m, {
      type: "seat-terminal",
      seat: "a",
      reason: "forfeit",
      score: "0",
      maxExponent: null,
      acceptedMoves: 0,
    }).state;
    await expect(driver.decide({ ...req, match: ended })).resolves.toEqual({
      kind: "idle",
      reason: "seat-terminal",
    });
  });

  it("a slow seat neither blocks the event loop nor a parallel seat", async () => {
    const driver = makeDriver({ poolOptions: { size: 2 } });
    const slow = driver.decide(request(match("slow"), "a", heavy));
    slow.catch(() => undefined);
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 10);
    const t0 = performance.now();
    const fast = await driver.decide(request(match("fast"), "b", greedy));
    const fastMs = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(timer);
    expect(fast.kind).toBe("move");
    expect(fastMs).toBeLessThan(5000);
    expect(maxGap).toBeLessThan(250);
    expect(driver.pending).toBe(1); // the slow search is still running in its worker
    expect(driver.cancel("slow:a")).toBe(true);
    await expect(slow).rejects.toMatchObject({ code: "CANCELLED" });
  }, 30_000);

  it("AbortSignal cancels an in-flight search; the worker is reused afterwards", async () => {
    const driver = makeDriver({ poolOptions: { size: 1 } });
    const controller = new AbortController();
    const pending = driver.decide(request(match("m3"), "a", heavy), { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 800));
    const t0 = performance.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(performance.now() - t0).toBeLessThan(500);
    // The single worker becomes free once the aborted search returns.
    const next = await driver.decide(request(match("m4"), "b", greedy));
    expect(next.kind).toBe("move");
  }, 30_000);

  it("one decision per seat at a time and a bounded queue", async () => {
    const driver = makeDriver({ poolOptions: { size: 1, seatQueueMax: 1 } });
    const m = match("m5");
    const first = driver.decide(request(m, "a", heavy));
    first.catch(() => undefined);
    await expect(driver.decide(request(m, "a", greedy))).rejects.toMatchObject({ code: "DUPLICATE_RUN" });
    const queued = driver.decide(request(m, "b", greedy));
    await expect(driver.decide(request(match("m6"), "a", greedy))).rejects.toMatchObject({
      code: "RUNNER_BUSY",
    });
    driver.cancel("m5:a");
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await queued).kind).toBe("move");
  }, 30_000);

  it("cancelling a queued decision removes it without running", async () => {
    const driver = makeDriver({ poolOptions: { size: 1 } });
    const busy = driver.decide(request(match("q1"), "a", heavy));
    busy.catch(() => undefined);
    const queued = driver.decide(request(match("q2"), "a", greedy));
    expect(driver.cancel("q2:a")).toBe(true);
    await expect(queued).rejects.toMatchObject({ code: "CANCELLED" });
    expect(driver.cancel("q2:a")).toBe(false);
    driver.cancel("q1:a");
    await expect(busy).rejects.toMatchObject({ code: "CANCELLED" });
  }, 30_000);
});
