import { describe, expect, it } from "vitest";
import { DUEL_RULES, customRules } from "@2048/contracts";
import { newGame, replay } from "@2048/engine";
import { BotGame, defaultBotConfig, startBotRun } from "../src/index.ts";
import type { BotConfig } from "@2048/contracts";

const cfg = (strategy: BotConfig["strategy"], nodeBudget = 800): BotConfig => ({ ...defaultBotConfig(strategy, "w"), nodeBudget });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await sleep(5);
  }
}

describe("worker_threads host (BOT-02)", () => {
  it("runs a bot game off-thread and matches the in-process result exactly", async () => {
    const progress: number[] = [];
    const handle = startBotRun({ config: cfg("heuristic"), rules: DUEL_RULES, gameSeed: "wg", maxMoves: 40, ignoreTimeBudget: true, onProgress: (r) => progress.push(r.sequence) });
    const res = await handle.done;
    expect(res.status).toBe("finished");
    expect(handle.status).toBe("finished");
    expect(res.movesPlayed).toBe(40);
    expect(progress).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    const local = new BotGame({ rules: DUEL_RULES, gameSeed: "wg", config: cfg("heuristic"), maxMoves: 40, ignoreTimeBudget: true });
    local.runToEnd();
    expect(res.directions).toEqual(local.moves);
    expect(res.state).toEqual(local.state);
    expect(res.score).toBe(local.state.score);
    expect(res.finalChecksum).toBe(local.last?.checksum);
    expect(res.botVersion).toBe("bots-1.0.0");
    expect(res.metadata).toMatchObject({ strategy: "heuristic", difficulty: 3, nodeBudget: 800 });
    expect(replay(newGame(DUEL_RULES, "wg"), res.directions, DUEL_RULES).state).toEqual(res.state);
  });

  it("does not block the host event loop while searching", async () => {
    const handle = startBotRun({ config: cfg("expectimax", 30_000), rules: DUEL_RULES, gameSeed: "busy", maxMoves: 30, ignoreTimeBudget: true });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const res = await handle.done;
    clearInterval(timer);
    expect(res.status).toBe("finished");
    expect(ticks).toBeGreaterThan(5);
  });

  it("starts paused, steps exactly one move at a time, resumes, and finishes", async () => {
    const handle = startBotRun({ config: cfg("greedy"), rules: DUEL_RULES, gameSeed: "pause", maxMoves: 10, ignoreTimeBudget: true, startPaused: true });
    expect(handle.status).toBe("paused");
    await sleep(150);
    expect(handle.movesPlayed).toBe(0);
    handle.step();
    await until(() => handle.movesPlayed === 1);
    await sleep(100);
    expect(handle.movesPlayed).toBe(1);
    expect(handle.status).toBe("paused");
    handle.step();
    handle.step();
    await until(() => handle.movesPlayed === 3);
    await sleep(100);
    expect(handle.movesPlayed).toBe(3);
    handle.resume();
    expect(handle.status).toBe("running");
    const res = await handle.done;
    expect(res.status).toBe("finished");
    expect(res.movesPlayed).toBe(10);
    // pausing never changes the outcome
    const local = new BotGame({ rules: DUEL_RULES, gameSeed: "pause", config: cfg("greedy"), maxMoves: 10, ignoreTimeBudget: true });
    local.runToEnd();
    expect(res.directions).toEqual(local.moves);
  });

  it("pauses a running game and keeps it idle until resume", async () => {
    const handle = startBotRun({ config: cfg("expectimax", 4000), rules: DUEL_RULES, gameSeed: "p2", maxMoves: 200, ignoreTimeBudget: true });
    await until(() => handle.movesPlayed >= 2);
    handle.pause();
    await sleep(300); // lets the in-flight move land
    const frozen = handle.movesPlayed;
    await sleep(300);
    expect(handle.movesPlayed).toBe(frozen);
    expect(handle.status).toBe("paused");
    handle.cancel();
    const res = await handle.done;
    expect(res.status).toBe("cancelled");
    expect(res.movesPlayed).toBe(frozen);
  });

  it("cancel interrupts a long search quickly and reports a legal partial result", async () => {
    // Huge budget: a full move would take many seconds; cancel must be observed inside the search.
    const handle = startBotRun({ config: { ...cfg("expectimax", 5_000_000), depth: 8 }, rules: DUEL_RULES, gameSeed: "cancel", ignoreTimeBudget: true });
    await sleep(150);
    const t0 = Date.now();
    handle.cancel();
    const res = await handle.done;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.status).toBe("cancelled");
    expect(res.movesPlayed).toBe(0);
    // idempotent
    handle.cancel();
    await handle.terminate();
  });

  it("time budget bounds each move when not in deterministic mode", async () => {
    const config = { ...cfg("expectimax", 5_000_000), timeBudgetMs: 30, depth: 8 };
    const t0 = Date.now();
    const res = await startBotRun({ config, rules: customRules({ boardSize: 4, moveCap: 15 }), gameSeed: "timed" }).done;
    expect(res.status).toBe("finished");
    expect(res.movesPlayed).toBe(15);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("surfaces worker errors as an error result, and validates config up front", async () => {
    expect(() => startBotRun({ config: { ...cfg("greedy"), nodeBudget: -1 }, rules: DUEL_RULES, gameSeed: "x" })).toThrow();
    const res = await startBotRun({ config: cfg("greedy"), rules: { ...DUEL_RULES, boardSize: 99 }, gameSeed: "x" }).done;
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy();
  });

  it("terminate() stops immediately", async () => {
    const handle = startBotRun({ config: { ...cfg("expectimax", 5_000_000), depth: 8 }, rules: DUEL_RULES, gameSeed: "term", ignoreTimeBudget: true });
    await sleep(50);
    await handle.terminate();
    const res = await handle.done;
    expect(res.status).toBe("cancelled");
  });

  it("runs four simultaneous hard bots while the host stays responsive (OPS-06 shape)", async () => {
    const runs = [0, 1, 2, 3].map((i) => startBotRun({ config: { ...cfg("expectimax", 3000), seed: `b${i}` }, rules: DUEL_RULES, gameSeed: `s${i}`, maxMoves: 25, ignoreTimeBudget: true }));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const results = await Promise.all(runs.map((r) => r.done));
    clearInterval(timer);
    expect(results.every((r) => r.status === "finished" && r.movesPlayed === 25)).toBe(true);
    expect(ticks).toBeGreaterThan(5);
  });
});
