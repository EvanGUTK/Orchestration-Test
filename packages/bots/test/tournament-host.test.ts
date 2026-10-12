import { describe, expect, it } from "vitest";
import { defaultBotConfig, runTournament, startTournament } from "../src/index.ts";
import type { BotConfig } from "@2048/contracts";

const cfg = (strategy: BotConfig["strategy"], seed: string, nodeBudget = 600): BotConfig => ({ ...defaultBotConfig(strategy, seed), nodeBudget });
const entries = [
  { id: "random", config: cfg("random", "r") },
  { id: "greedy", config: cfg("greedy", "g") },
  { id: "heuristic", config: cfg("heuristic", "h") },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tournament in a worker thread", () => {
  it("returns exactly the same result as the in-process runTournament, with per-game progress", async () => {
    const opts = { entries, gameSeeds: ["a", "b"], maxMoves: 40 };
    const progress: number[] = [];
    const handle = startTournament({ ...opts, onProgress: (p) => progress.push(p.completed) });
    const outcome = await handle.done;
    expect(outcome.status).toBe("finished");
    expect(handle.status).toBe("finished");
    expect(outcome.result).toEqual(runTournament(opts));
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(handle.completed).toBe(6);
    expect(handle.totalGames).toBe(6);
  });

  it("does not block the host event loop", async () => {
    const handle = startTournament({ entries: [{ id: "e1", config: cfg("expectimax", "x", 4000) }, { id: "e2", config: cfg("heuristic", "y", 4000) }], gameSeeds: ["s1", "s2"], maxMoves: 40 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const outcome = await handle.done;
    clearInterval(timer);
    expect(outcome.status).toBe("finished");
    expect(ticks).toBeGreaterThan(5);
  });

  it("cancels mid-game: stops quickly, reports cancelled with the games completed so far", async () => {
    const big = { ...cfg("expectimax", "slow", 5_000_000), depth: 8 };
    const handle = startTournament({ entries: [{ id: "a", config: big }, { id: "b", config: { ...big, seed: "other" } }], gameSeeds: ["s1", "s2", "s3"] });
    await sleep(150);
    const t0 = Date.now();
    handle.cancel();
    handle.cancel(); // idempotent
    const outcome = await handle.done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.result?.cancelled).toBe(true);
    expect(outcome.result?.games).toHaveLength(0);
  });

  it("a cancelled partial run keeps finished games and flags cancelled", async () => {
    const quick = [{ id: "r", config: cfg("random", "r") }, { id: "g", config: cfg("greedy", "g") }];
    const handle: ReturnType<typeof startTournament> = startTournament({ entries: quick, gameSeeds: ["a", "b", "c", "d", "e", "f", "g", "h"], maxMoves: 20_000, onProgress: (p) => { if (p.completed === 2) handle.cancel(); } });
    const outcome = await handle.done;
    expect(["cancelled", "finished"]).toContain(outcome.status);
    if (outcome.status === "cancelled") {
      expect(outcome.result.games.length).toBeGreaterThanOrEqual(2);
      expect(outcome.result.games.length).toBeLessThan(16);
    }
  });

  it("validates input synchronously and reports worker errors", async () => {
    expect(() => startTournament({ entries: [entries[0]!, { id: "bad", config: { ...entries[1]!.config, nodeBudget: 0 } }], gameSeeds: ["a"] })).toThrow();
    const outcome = await startTournament({ entries: [entries[0]!], gameSeeds: ["a"] }).done; // needs >= 2 entries
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/two entries/);
  });

  it("terminate() resolves immediately", async () => {
    const big = { ...cfg("expectimax", "slow", 5_000_000), depth: 8 };
    const handle = startTournament({ entries: [{ id: "a", config: big }, { id: "b", config: big }], gameSeeds: ["s"] });
    await sleep(50);
    await handle.terminate();
    expect((await handle.done).status).toBe("error");
  });
});
