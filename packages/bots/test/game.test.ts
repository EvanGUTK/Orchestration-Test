import { describe, expect, it } from "vitest";
import { DUEL_RULES, compareDecimal, customRules } from "@2048/contracts";
import { newGame, replay } from "@2048/engine";
import { BOT_STRATEGIES, BotGame, defaultBotConfig, runTournament } from "../src/index.ts";
import type { BotConfig } from "@2048/contracts";

const cfg = (strategy: BotConfig["strategy"], seed = "bot", nodeBudget = 1500): BotConfig => ({ ...defaultBotConfig(strategy, seed), nodeBudget });

describe("BotGame (bot plays the real engine)", () => {
  it("is deterministic and its move list replays to the identical final state and checksum", () => {
    for (const strategy of BOT_STRATEGIES) {
      const run = () => {
        const g = new BotGame({ rules: DUEL_RULES, gameSeed: "g1", config: cfg(strategy), maxMoves: 60, ignoreTimeBudget: true });
        g.runToEnd();
        return g;
      };
      const a = run();
      const b = run();
      expect(a.moves).toEqual(b.moves);
      expect(a.state).toEqual(b.state);
      expect(a.moves.length).toBeGreaterThan(0);
      const rep = replay(newGame(DUEL_RULES, "g1"), a.moves, DUEL_RULES);
      expect(rep.state).toEqual(a.state);
      expect(rep.steps.at(-1)?.checksum).toBe(a.last?.checksum);
      expect(rep.steps.every((s) => s.changed)).toBe(true);
    }
  });

  it("respects maxMoves and the ruleset move cap, and works on custom board sizes", () => {
    const capped = new BotGame({ rules: customRules({ boardSize: 3, moveCap: 12 }), gameSeed: "c", config: cfg("heuristic"), ignoreTimeBudget: true });
    capped.runToEnd();
    expect(capped.moves.length).toBeLessThanOrEqual(12);
    expect(capped.state.board.size).toBe(3);
    const five = new BotGame({ rules: customRules({ boardSize: 5 }), gameSeed: "c5", config: cfg("greedy"), maxMoves: 25, ignoreTimeBudget: true });
    five.runToEnd();
    expect(five.moves.length).toBe(25);
    expect(five.finished).toBe(true);
    expect(five.step()).toBeNull();
  });

  it("the game seed and bot seed are independent: changing the bot seed does not change the spawn stream", () => {
    const a = new BotGame({ rules: DUEL_RULES, gameSeed: "g", config: cfg("random", "botA"), maxMoves: 1, ignoreTimeBudget: true });
    const b = new BotGame({ rules: DUEL_RULES, gameSeed: "g", config: cfg("random", "botB"), maxMoves: 1, ignoreTimeBudget: true });
    expect(a.state).toEqual(b.state); // same initial board from the game seed
  });

  it("search bots clearly outplay the random bot on identical seeds", () => {
    const seeds = ["s1", "s2", "s3"];
    const total = (strategy: BotConfig["strategy"]) => seeds.reduce((sum, seed) => {
      const g = new BotGame({ rules: DUEL_RULES, gameSeed: seed, config: cfg(strategy, "t", 800), maxMoves: 150, ignoreTimeBudget: true });
      g.runToEnd();
      return sum + BigInt(g.state.score);
    }, 0n);
    const random = total("random");
    expect(total("heuristic")).toBeGreaterThan(random);
    expect(total("expectimax")).toBeGreaterThan(random);
  });
});

describe("tournament (BOT-04)", () => {
  const entries = [
    { id: "random", config: cfg("random", "r") },
    { id: "greedy", config: cfg("greedy", "g") },
    { id: "heuristic", config: cfg("heuristic", "h", 600) },
  ];
  const opts = { entries, gameSeeds: ["a", "b"], maxMoves: 60 };

  it("same seeds + versions + budgets reproduce identical results and checksum", () => {
    const one = runTournament(opts);
    const two = runTournament(opts);
    expect(two).toEqual(one);
    expect(one.games).toHaveLength(6);
    expect(one.resultsChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(one.botVersion).toBe("bots-1.0.0");
    expect(one.rulesetVersion).toBe("duel-v1");
    expect(one.table.map((r) => r.played)).toEqual([2, 2, 2]);
  });

  it("results do not depend on wall time (heavy timeBudgetMs differences change nothing)", () => {
    const tight = runTournament({ ...opts, entries: entries.map((e) => ({ ...e, config: { ...e.config, timeBudgetMs: 1 } })) });
    const loose = runTournament({ ...opts, entries: entries.map((e) => ({ ...e, config: { ...e.config, timeBudgetMs: 60_000 } })) });
    expect(tight.resultsChecksum).toBe(loose.resultsChecksum);
  });

  it("changing a budget or seed changes the checksum", () => {
    const base = runTournament(opts);
    const diffBudget = runTournament({ ...opts, entries: entries.map((e) => (e.id === "heuristic" ? { ...e, config: { ...e.config, nodeBudget: 40 } } : e)) });
    const diffSeed = runTournament({ ...opts, gameSeeds: ["a", "c"] });
    expect(diffBudget.resultsChecksum).not.toBe(base.resultsChecksum);
    expect(diffSeed.resultsChecksum).not.toBe(base.resultsChecksum);
  });

  it("builds a consistent league table with exact decimals", () => {
    const r = runTournament(opts);
    const points = r.table.reduce((s, row) => s + row.points, 0);
    expect(points).toBe(2 * 3 * 2); // 3 pairings x 2 seeds x 2 points per pairing
    for (const row of r.table) {
      expect(row.wins + row.draws + row.losses).toBe(row.played * 2);
      const total = r.games.filter((g) => g.entryId === row.entryId).reduce((s, g) => s + BigInt(g.score), 0n);
      expect(row.totalScore).toBe(total.toString());
    }
    for (let i = 1; i < r.table.length; i++) {
      const a = r.table[i - 1]!;
      const b = r.table[i]!;
      expect(a.points > b.points || (a.points === b.points && compareDecimal(a.totalScore, b.totalScore) >= 0)).toBe(true);
    }
  });

  it("validates inputs", () => {
    expect(() => runTournament({ ...opts, entries: [entries[0]!] })).toThrow();
    expect(() => runTournament({ ...opts, gameSeeds: [] })).toThrow();
    expect(() => runTournament({ ...opts, entries: [entries[0]!, { ...entries[0]! }] })).toThrow(/unique/);
    expect(() => runTournament({ ...opts, entries: [entries[0]!, { id: "x", config: { ...entries[1]!.config, nodeBudget: 0 } }] })).toThrow();
  });

  it("stops between games on cancel", () => {
    const r = runTournament({ ...opts, signal: { aborted: true } });
    expect(r.cancelled).toBe(true);
    expect(r.games).toHaveLength(0);
  });
});
