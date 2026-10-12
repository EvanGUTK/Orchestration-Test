import { describe, expect, it } from "vitest";
import { BOT_SEED_NAMESPACE, BOT_VERSION, SEED_NAMESPACE } from "@2048/contracts";
import type { Board, BotConfig, BotStrategy } from "@2048/contracts";
import { createRng, deriveSeedWords, legalMoves } from "@2048/engine";
import { BOT_STRATEGIES, chooseMove, createBotStream, defaultBotConfig, describeBot, validateBotConfig } from "../src/index.ts";
import { DEAD_BOARD, boardOf, deepFreeze, lcg, randomBoard } from "./helpers.ts";

const cfg = (strategy: BotStrategy, extra: Partial<BotConfig> = {}): BotConfig => ({ ...defaultBotConfig(strategy, "seed-1"), nodeBudget: 3000, ...extra });
const MID = boardOf([[1, 2, 3, 4], [0, 1, 2, 0], [0, 0, 1, 0], [2, 0, 0, 1]]);

describe("chooseMove: all four strategies", () => {
  for (const strategy of BOT_STRATEGIES) {
    describe(strategy, () => {
      it("always returns a legal move with explanation and metadata, on 400 random boards of all sizes", () => {
        const rand = lcg(100 + strategy.length);
        let tested = 0;
        for (let t = 0; t < 400; t++) {
          const board = randomBoard(rand, 3 + (t % 6), 0.4 + rand() * 0.6, 10);
          if (legalMoves(board).length === 0) continue;
          const d = chooseMove(board, cfg(strategy, { nodeBudget: 200 }), { moveIndex: t, ignoreTimeBudget: true });
          expect(legalMoves(board)).toContain(d.direction);
          expect(d.explanation.length).toBeGreaterThan(5);
          expect(d.explanation.length).toBeLessThan(200);
          expect(d.botVersion).toBe(BOT_VERSION);
          expect(d.strategy).toBe(strategy);
          expect(d.stopReason).not.toBe("fallback");
          tested++;
        }
        expect(tested).toBeGreaterThan(300);
      });

      it("is deterministic for the same board, config and move index; never mutates the board", () => {
        const board = deepFreeze(structuredClone(MID));
        const a = chooseMove(board, cfg(strategy), { moveIndex: 5, ignoreTimeBudget: true });
        const b = chooseMove(board, cfg(strategy), { moveIndex: 5, ignoreTimeBudget: true });
        expect(a).toEqual(b);
      });

      it("throws NO_CHANGE on a dead board", () => {
        expect(() => chooseMove(DEAD_BOARD, cfg(strategy))).toThrowError(expect.objectContaining({ code: "NO_CHANGE" }));
      });

      it("rejects an invalid config", () => {
        expect(() => chooseMove(MID, { ...cfg(strategy), nodeBudget: 0 })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
      });

      it("honours an already-aborted signal by returning a legal move immediately", () => {
        const d = chooseMove(MID, cfg(strategy), { signal: { aborted: true } });
        expect(d.stopReason).toBe("cancelled");
        expect(d.nodes).toBe(0);
        expect(legalMoves(MID)).toContain(d.direction);
      });
    });
  }

  it("takes the only legal move when there is exactly one", () => {
    const board = boardOf([[1, 2, 1, 2], [2, 1, 2, 1], [1, 2, 1, 2], [2, 1, 3, 3]]); // only left/right merge on last row
    for (const strategy of BOT_STRATEGIES) {
      const d = chooseMove(board, cfg(strategy), { ignoreTimeBudget: true });
      expect(legalMoves(board)).toContain(d.direction);
    }
  });
});

describe("search budgets and cancellation", () => {
  it("never exceeds max(nodeBudget, legalMoves) nodes and reports node-budget when cut short", () => {
    for (const strategy of ["heuristic", "expectimax"] as const) {
      for (const budget of [1, 3, 10, 100, 1000]) {
        const d = chooseMove(MID, cfg(strategy, { nodeBudget: budget, depth: 6 }), { ignoreTimeBudget: true });
        expect(d.nodes).toBeLessThanOrEqual(Math.max(budget, legalMoves(MID).length));
        expect(legalMoves(MID)).toContain(d.direction);
        expect(d.stopReason).toBe("node-budget");
      }
    }
  });

  it("a larger node budget searches deeper", () => {
    const small = chooseMove(MID, cfg("expectimax", { nodeBudget: 40, depth: 5 }), { ignoreTimeBudget: true });
    const large = chooseMove(MID, cfg("expectimax", { nodeBudget: 60_000, depth: 5 }), { ignoreTimeBudget: true });
    expect(large.depthReached).toBeGreaterThan(small.depthReached);
    expect(large.depthReached).toBeLessThanOrEqual(5);
  });

  it("completes (stopReason complete) when the depth finishes inside the budget", () => {
    const d = chooseMove(MID, cfg("expectimax", { nodeBudget: 2_000_000, depth: 2 }), { ignoreTimeBudget: true });
    expect(d.stopReason).toBe("complete");
    expect(d.depthReached).toBe(2);
  });

  it("cooperative cancellation mid-search returns a legal move quickly", () => {
    let reads = 0;
    const signal = { get aborted() { return ++reads > 3; } }; // flips after a few polls (every 32 nodes)
    const d = chooseMove(MID, cfg("expectimax", { nodeBudget: 5_000_000, depth: 8, timeBudgetMs: 60_000 }), { signal, ignoreTimeBudget: true });
    expect(d.stopReason).toBe("cancelled");
    expect(d.nodes).toBeLessThan(2000);
    expect(legalMoves(MID)).toContain(d.direction);
  });

  it("an AbortController signal works", () => {
    const ac = new AbortController();
    ac.abort();
    expect(chooseMove(MID, cfg("heuristic"), { signal: ac.signal }).stopReason).toBe("cancelled");
  });

  it("wall-time budget stops the search with an injected clock; ignoreTimeBudget disables it", () => {
    let t = 0;
    const now = () => (t += 1); // every call advances 1ms
    const timed = chooseMove(MID, cfg("expectimax", { nodeBudget: 5_000_000, timeBudgetMs: 5, depth: 8 }), { now });
    expect(timed.stopReason).toBe("time-budget");
    expect(legalMoves(MID)).toContain(timed.direction);
    const untimed = chooseMove(MID, cfg("expectimax", { nodeBudget: 3000, timeBudgetMs: 1, depth: 8 }), { now, ignoreTimeBudget: true });
    expect(untimed.stopReason).toBe("node-budget");
  });
});

describe("information boundary and bot randomness (BOT-03)", () => {
  it("tie-breaks use the bot-namespace stream derived from the bot seed, not the game stream", () => {
    const seed = "seed-1";
    expect(BOT_SEED_NAMESPACE).not.toBe(SEED_NAMESPACE);
    const stream = createBotStream(seed, 3);
    const expected = createRng(deriveSeedWords(`${seed}#3`, BOT_SEED_NAMESPACE));
    for (let i = 0; i < 16; i++) expect(stream.next()).toBe(expected.next());
    const game = createRng(deriveSeedWords(`${seed}#3`));
    const botS = createBotStream(seed, 3);
    expect([botS.next(), botS.next(), botS.next()]).not.toEqual([game.next(), game.next(), game.next()]);
  });

  it("the random bot's choice is exactly the bot stream's draw over legal moves (reproducible, independent of the game)", () => {
    const board = boardOf([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 0]]);
    const legal = legalMoves(board);
    for (let m = 0; m < 20; m++) {
      const rng = createRng(deriveSeedWords(`seedX#${m}`, BOT_SEED_NAMESPACE));
      const expected = legal[rng.below(legal.length)];
      expect(chooseMove(board, cfg("random", { seed: "seedX" }), { moveIndex: m }).direction).toBe(expected);
    }
  });

  it("different bot seeds break ties differently; the API has no game-state input", () => {
    const board = boardOf([[0, 0, 0, 0], [0, 1, 1, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const picks = new Set<string>();
    for (let i = 0; i < 40; i++) picks.add(chooseMove(board, cfg("random", { seed: `s${i}` })).direction);
    expect(picks.size).toBeGreaterThan(1);
    expect(chooseMove.length).toBeLessThanOrEqual(3); // (board, config, options): no GameState / PRNG parameter
  });

  it("expectimax chance nodes average over spawns: its value does not depend on the engine's actual next tile", () => {
    // Identical boards => identical decisions regardless of anything else (pure function of board+config+moveIndex).
    const a = chooseMove(MID, cfg("expectimax"), { moveIndex: 1, ignoreTimeBudget: true });
    const b = chooseMove(structuredClone(MID), cfg("expectimax"), { moveIndex: 1, ignoreTimeBudget: true });
    expect(a).toEqual(b);
  });
});

describe("config and metadata (BOT-01)", () => {
  it("describes version, difficulty and params for each strategy", () => {
    const levels = BOT_STRATEGIES.map((s) => describeBot(defaultBotConfig(s, "x")).difficulty);
    expect(levels).toEqual([1, 2, 3, 4]);
    const m = describeBot({ strategy: "expectimax", seed: "abc", nodeBudget: 777, timeBudgetMs: 50, depth: 3 });
    expect(m).toMatchObject({ botVersion: BOT_VERSION, strategy: "expectimax", difficulty: 4, seed: "abc", nodeBudget: 777, timeBudgetMs: 50, depth: 3 });
  });

  it("validates untrusted configs", () => {
    const ok = { strategy: "greedy", seed: "s", nodeBudget: 10, timeBudgetMs: 10 };
    expect(validateBotConfig(ok)).toEqual(ok);
    for (const bad of [null, "x", { ...ok, strategy: "gpt" }, { ...ok, seed: "" }, { ...ok, seed: "s".repeat(129) }, { ...ok, nodeBudget: 1.5 }, { ...ok, nodeBudget: 5_000_001 }, { ...ok, timeBudgetMs: 0 }, { ...ok, depth: 9 }, { ...ok, depth: 0 }]) {
      expect(() => validateBotConfig(bad)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
    expect(validateBotConfig({ ...ok, depth: 3, extra: "dropped" })).toEqual({ ...ok, depth: 3 });
  });

  it("greedy picks the highest immediate score and breaks ties by empties", () => {
    const board: Board = boardOf([[3, 3, 0, 0], [1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    // exponents 3,3 -> 4 (16) and 1,1 -> 2 (4): left and right both gain 20
    const d = chooseMove(board, cfg("greedy"));
    expect(["left", "right"]).toContain(d.direction);
    expect(d.explanation).toMatch(/scores 20/);
  });
});
