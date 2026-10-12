import { RULESETS } from "@g2048/contracts";
import type { BotConfig } from "@g2048/contracts";
import { replay } from "@g2048/engine";
import { describe, expect, it } from "vitest";
import { engineAdapter } from "./engine-adapter.js";
import { playBotGame, runTournament } from "./play.js";

const duel = RULESETS["duel-v1"];
const random: BotConfig = { strategy: "random-v1", nodeBudget: 1, timeBudgetMs: 1000 };
const greedy: BotConfig = { strategy: "greedy-v1", nodeBudget: 4, timeBudgetMs: 1000 };
const heuristic: BotConfig = { strategy: "heuristic-v1", nodeBudget: 500, timeBudgetMs: 1000 };
const expectimax: BotConfig = { strategy: "expectimax-v1", nodeBudget: 600, timeBudgetMs: 1000 };
const SEEDS = ["league-1", "league-2", "league-3", "league-4", "league-5", "league-6"];

describe("playBotGame", () => {
  it("plays to a terminal state with legal, replay-verifiable moves", () => {
    const r = playBotGame(engineAdapter, { rules: duel, config: greedy, seed: "replay-check" });
    expect(["move-cap", "dead-board"]).toContain(r.end);
    expect(r.moves.length).toBe(r.acceptedMoves);
    expect(r.finalState.status).toBe("completed");
    expect(r).toMatchObject({ strategy: "greedy-v1", difficulty: "medium", botVersion: "bots-1.0.0" });
    const replayed = replay(engineAdapter.newGame(duel, "replay-check"), r.moves, duel);
    expect(replayed.final).toEqual(r.finalState);
  });

  it("is deterministic: same seed/config/budget => identical move sequence (BOT-04)", () => {
    for (const config of [random, greedy, heuristic, expectimax]) {
      const a = playBotGame(engineAdapter, { rules: duel, config, seed: "repeat", maxMoves: 120 });
      const b = playBotGame(engineAdapter, { rules: duel, config, seed: "repeat", maxMoves: 120 });
      expect(b.moves).toEqual(a.moves);
      expect(b.finalScore).toBe(a.finalScore);
    }
  });

  it("different bot seeds change random-v1 play but never the game's spawn stream", () => {
    const a = playBotGame(engineAdapter, {
      rules: duel,
      config: random,
      seed: "g",
      botSeed: "x",
      maxMoves: 30,
    });
    const b = playBotGame(engineAdapter, {
      rules: duel,
      config: random,
      seed: "g",
      botSeed: "y",
      maxMoves: 30,
    });
    expect(b.moves).not.toEqual(a.moves);
    expect(engineAdapter.newGame(duel, "g").board).toEqual(engineAdapter.newGame(duel, "g").board);
  });

  it("respects maxMoves and the cancel signal", () => {
    expect(
      playBotGame(engineAdapter, { rules: RULESETS["bot-v1"], config: greedy, seed: "s", maxMoves: 7 }),
    ).toMatchObject({
      end: "max-moves",
      acceptedMoves: 7,
    });
    expect(
      playBotGame(engineAdapter, { rules: duel, config: greedy, seed: "s", signal: { cancelled: true } }),
    ).toMatchObject({ end: "cancelled", acceptedMoves: 0 });
  });
});

describe("strength", () => {
  it("expectimax-v1 beats random-v1 on every fixed seed (duel-v1, 500-move cap)", () => {
    const rows = SEEDS.map((seed) => {
      const r = playBotGame(engineAdapter, { rules: duel, config: random, seed });
      const e = playBotGame(engineAdapter, { rules: duel, config: expectimax, seed });
      return { seed, random: BigInt(r.finalScore), expectimax: BigInt(e.finalScore) };
    });
    const sum = (k: "random" | "expectimax"): bigint => rows.reduce((t, r) => t + r[k], 0n);
    expect(sum("expectimax")).toBeGreaterThan(2n * sum("random"));
    for (const row of rows) expect(row.expectimax).toBeGreaterThan(row.random);
  }, 60_000);
});

describe("runTournament", () => {
  const pairings = [
    { a: expectimax, b: random },
    { a: greedy, b: heuristic },
    { a: random, b: random },
  ];

  it("is reproducible and scores every game with duel rules", () => {
    const first = runTournament(engineAdapter, { seeds: SEEDS.slice(0, 3), pairings });
    const second = runTournament(engineAdapter, { seeds: SEEDS.slice(0, 3), pairings });
    expect(second).toEqual(first);
    expect(first.rulesetVersion).toBe("duel-v1");
    expect(first.games).toHaveLength(9);
    for (const g of first.games) {
      expect(g.a.acceptedMoves).toBeLessThanOrEqual(500);
      expect(["move-cap", "dead-board"]).toContain(g.a.terminal);
      if (g.pairing === 0) expect(g.outcome).toBe("seat-a");
      // A mirror match on the same seed with the same bot seed is identical, hence a draw.
      if (g.pairing === 2) expect(g.outcome).toBe("draw");
    }
    const ex = first.table.find((r) => r.label === "expectimax-v1/600");
    expect(ex).toMatchObject({ played: 3, won: 3, lost: 0 });
    const rnd = first.table.find((r) => r.label === "random-v1/1");
    expect(rnd).toMatchObject({ played: 9, won: 0, drawn: 6, lost: 3 });
    expect(first.table[0]?.label).toBe("expectimax-v1/600");
  }, 60_000);
});
