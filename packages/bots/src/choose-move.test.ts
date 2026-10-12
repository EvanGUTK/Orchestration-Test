import { BOT_STRATEGIES, DIRECTIONS, practiceRuleset, RULESETS } from "@g2048/contracts";
import type { BotConfig, BotStrategy, GameState, RandomState, Ruleset } from "@g2048/contracts";
import { legalMoves } from "@g2048/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BOT_VERSION, BotError, createChooseMove, deriveBotRng } from "./choose-move.js";
import type { ChooseMoveResult } from "./choose-move.js";
import { engineAdapter } from "./engine-adapter.js";
import type { EnginePort } from "./engine-port.js";
import { chooseMove } from "./index.js";
import { arbBoard, arbRng, board, stateFor } from "./test-helpers.js";

const rulesFor = (size: number): Ruleset =>
  size === 4 ? RULESETS["duel-v1"] : practiceRuleset({ size, fourWeight: 1, undo: false });
const cfg = (strategy: BotStrategy, nodeBudget = 400, timeBudgetMs = 1000): BotConfig => ({
  strategy,
  nodeBudget,
  timeBudgetMs,
});
const botRng = deriveBotRng(engineAdapter, "seed-1");

function move(result: ChooseMoveResult) {
  if (result.kind !== "move") throw new Error(`expected a move, got ${result.kind}`);
  return result;
}

const mid = stateFor(
  board([
    [1, 1, 2, null],
    [3, null, 3, null],
    [null, 2, null, 1],
    [4, null, null, 2],
  ]),
);

describe("chooseMove legality (BOT-01)", () => {
  for (const strategy of BOT_STRATEGIES) {
    it(`${strategy} always returns an engine-legal move on random boards`, () => {
      fc.assert(
        fc.property(arbBoard(), arbRng, fc.integer({ min: 1, max: 600 }), (b, rng, budget) => {
          const result = chooseMove(stateFor(b), rulesFor(b.size), cfg(strategy, budget), rng);
          const legal = legalMoves(b);
          if (legal.length === 0) {
            expect(result).toEqual({ kind: "no-legal-move", reason: "dead-board", rng });
            return;
          }
          const { decision } = move(result);
          expect(legal).toContain(decision.direction);
          expect(decision.strategy).toBe(strategy);
          expect(decision.botVersion).toBe(BOT_VERSION);
          expect(decision.nodesSearched).toBeLessThanOrEqual(budget);
          expect(decision.explanation.length).toBeGreaterThan(0);
        }),
        { numRuns: strategy === "expectimax-v1" ? 150 : 300 },
      );
    });
  }

  it("returns a typed no-legal-move result on a dead board or inactive game", () => {
    const dead = stateFor(
      board([
        [1, 2, 1, 2],
        [2, 1, 2, 1],
        [1, 2, 1, 2],
        [2, 1, 2, 1],
      ]),
    );
    for (const strategy of BOT_STRATEGIES) {
      expect(chooseMove(dead, RULESETS["duel-v1"], cfg(strategy), botRng)).toEqual({
        kind: "no-legal-move",
        reason: "dead-board",
        rng: botRng,
      });
      const completed: GameState = { ...mid, status: "completed" };
      expect(chooseMove(completed, RULESETS["duel-v1"], cfg(strategy), botRng).kind).toBe("no-legal-move");
    }
  });

  it("validates the config", () => {
    const rules = RULESETS["duel-v1"];
    expect(() => chooseMove(mid, rules, cfg("llm-v1" as BotStrategy), botRng)).toThrow(BotError);
    expect(() => chooseMove(mid, rules, cfg("greedy-v1", 0), botRng)).toThrow(BotError);
    expect(() => chooseMove(mid, rules, cfg("greedy-v1", 5_000_001), botRng)).toThrow(BotError);
    expect(() => chooseMove(mid, rules, cfg("greedy-v1", 10, 10_001), botRng)).toThrow(BotError);
    expect(() => chooseMove(mid, rules, cfg("greedy-v1", 10.5), botRng)).toThrow(BotError);
  });
});

describe("strategy behaviour", () => {
  it("random-v1 draws only from the bot RNG and covers every legal move", () => {
    const seen = new Set<string>();
    let rng = botRng;
    for (let i = 0; i < 200; i += 1) {
      const r = move(chooseMove(mid, RULESETS["duel-v1"], cfg("random-v1"), rng));
      seen.add(r.decision.direction);
      expect(r.rng).not.toEqual(rng);
      rng = r.rng;
    }
    expect([...seen].sort()).toEqual([...legalMoves(mid.board)].sort());
  });

  it("greedy-v1 maximises the exact merge score, even above 2^53", () => {
    // Row 0 merges 2^60 + 2^60 (left/right); column 3 merges 2^3 + 2^3 (up/down).
    const s = stateFor(
      board([
        [60, 60, null, 3],
        [null, null, null, 3],
        [null, null, null, null],
        [null, null, null, null],
      ]),
    );
    const r = move(chooseMove(s, RULESETS["duel-v1"], cfg("greedy-v1"), botRng));
    expect(["left", "right"]).toContain(r.decision.direction);
    expect(r.decision.explanation).toContain((2n ** 61n).toString());
    expect(r.decision.explanation).toContain("tie between right/left");
    expect(r.decision.nodesSearched).toBe(4);
  });

  it("expectimax-v1 keeps the max tile in its corner when a safe move exists", () => {
    const s = stateFor(
      board([
        [9, 8, 7, 6],
        [2, 3, 4, 5],
        [1, null, null, null],
        [null, null, null, null],
      ]),
    );
    const r = move(chooseMove(s, RULESETS["duel-v1"], cfg("expectimax-v1", 5000), botRng));
    expect(r.decision.fallback).toBe(false);
    expect(r.decision.direction).not.toBe("down");
    expect(engineAdapter.slide(s.board, r.decision.direction).board.cells[0]).toBe("9");
  });

  it("deeper budgets are reported in the explanation", () => {
    const shallow = move(chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 60), botRng));
    const deep = move(chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 20_000), botRng));
    expect(shallow.decision.explanation).toMatch(/at depth 1/);
    expect(deep.decision.explanation).toMatch(/at depth [2-4]/);
    expect(deep.decision.nodesSearched).toBeGreaterThan(shallow.decision.nodesSearched);
  });
});

describe("determinism", () => {
  it("same board, rules, config and bot RNG give the same decision and next RNG", () => {
    fc.assert(
      fc.property(arbBoard(), arbRng, fc.constantFrom(...BOT_STRATEGIES), (b, rng, strategy) => {
        const rules = rulesFor(b.size);
        const first = chooseMove(stateFor(b), rules, cfg(strategy, 300), rng);
        const second = chooseMove(stateFor(b), rules, cfg(strategy, 300), rng);
        expect(second).toEqual(first);
      }),
      { numRuns: 200 },
    );
  });
});

describe("budgets, cancellation and fallback (BOT-02)", () => {
  it("never searches more nodes than the node budget", () => {
    for (const strategy of BOT_STRATEGIES) {
      for (const budget of [1, 2, 3, 7, 50, 999]) {
        const r = move(chooseMove(mid, RULESETS["duel-v1"], cfg(strategy, budget), botRng));
        expect(r.decision.nodesSearched).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("falls back to the first legal move when the budget cannot finish depth 1", () => {
    const r = move(chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 2), botRng));
    expect(r.decision.fallback).toBe(true);
    expect(r.decision.direction).toBe(legalMoves(mid.board)[0]);
    expect(r.decision.explanation).toMatch(/node budget exhausted/);
    expect(r.rng).toEqual(botRng); // fallback consumes no bot randomness
  });

  it("keeps the last completed depth when the budget stops a deeper iteration", () => {
    const r = move(chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 100), botRng));
    expect(r.decision.fallback).toBe(false);
    expect(r.decision.nodesSearched).toBe(100);
  });

  it("enforces the time budget through the injected clock only", () => {
    // Clock jumps past the deadline right after the budget starts: nothing completes.
    let reads = 0;
    const expired = (): number => (reads++ === 0 ? 0 : 10_000);
    const timed = move(
      chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 1_000_000, 1000), botRng, undefined, {
        now: expired,
      }),
    );
    expect(timed.decision).toMatchObject({ fallback: true, nodesSearched: 0 });
    expect(timed.decision.explanation).toMatch(/time budget exhausted/);

    // Clock advancing 600 ms per read: depth 1 completes, deeper iterations are cut off.
    let t = 0;
    const slow = (): number => (t += 600);
    const partial = move(
      chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 1_000_000, 1000), botRng, undefined, {
        now: slow,
      }),
    );
    expect(partial.decision.fallback).toBe(false);
    expect(partial.decision.explanation).toMatch(/at depth 1/);
    expect(partial.decision.nodesSearched).toBeLessThanOrEqual(16);

    // Without a clock the same config is purely node-bounded (timeBudgetMs is not consulted).
    const untimed = move(chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 3000, 1), botRng));
    expect(untimed.decision.fallback).toBe(false);
    expect(untimed.decision.nodesSearched).toBe(3000);
  });

  it("stops at once when cancelled, still returning a legal move", () => {
    const r = move(
      chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 1_000_000), botRng, { cancelled: true }),
    );
    expect(r.decision).toMatchObject({
      fallback: true,
      nodesSearched: 0,
      direction: legalMoves(mid.board)[0],
    });
    expect(r.decision.explanation).toMatch(/cancelled/);
  });

  it("cancellation mid-search returns promptly with a legal move", () => {
    let reads = 0;
    const signal = {
      get cancelled(): boolean {
        reads += 1;
        return reads > 500;
      },
    };
    const r = move(chooseMove(mid, RULESETS["duel-v1"], cfg("expectimax-v1", 5_000_000), botRng, signal));
    expect(r.decision.nodesSearched).toBeLessThanOrEqual(500);
    expect(legalMoves(mid.board)).toContain(r.decision.direction);
  });
});

describe("information boundary (BOT-03)", () => {
  it("never reads state.rng", () => {
    const guarded = new Proxy(mid, {
      get(target, key, receiver) {
        if (key === "rng") throw new Error("bot read the game's spawn stream");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    for (const strategy of BOT_STRATEGIES) {
      expect(() => chooseMove(guarded, RULESETS["duel-v1"], cfg(strategy, 3000), botRng)).not.toThrow();
    }
  });

  it("states identical except for the game RNG produce identical decisions", () => {
    fc.assert(
      fc.property(
        arbBoard(),
        arbRng,
        arbRng,
        fc.constantFrom(...BOT_STRATEGIES),
        (b, rngA, rngB, strategy) => {
          const rules = rulesFor(b.size);
          const a = chooseMove(stateFor(b, rngA), rules, cfg(strategy, 300), botRng);
          const c = chooseMove(stateFor(b, rngB), rules, cfg(strategy, 300), botRng);
          expect(c).toEqual(a);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never simulates the real spawn stream: search uses only slide and the bot RNG", () => {
    const seen: RandomState[] = [];
    const spy: EnginePort = {
      ...engineAdapter,
      applyMove: () => {
        throw new Error("applyMove must not be used for search");
      },
      newGame: () => {
        throw new Error("newGame must not be used for search");
      },
      uniform: (rng, n) => {
        seen.push(rng);
        return engineAdapter.uniform(rng, n);
      },
    };
    const choose = createChooseMove(spy);
    for (const strategy of BOT_STRATEGIES) choose(mid, RULESETS["duel-v1"], cfg(strategy, 2000), botRng);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((rng) => rng.words.join() === mid.rng.words.join())).toBe(false);
  });

  it("the bot stream is derived under BOT_SEED_NAMESPACE, distinct from the game stream", () => {
    const game = engineAdapter.newGame(RULESETS["duel-v1"], "same-seed");
    expect(deriveBotRng(engineAdapter, "same-seed")).not.toEqual(game.rng);
    expect(deriveBotRng(engineAdapter, "same-seed")).toEqual(
      engineAdapter.deriveRandomState("2048-infinite/bot/v1:", "same-seed"),
    );
  });

  it("directions follow the stable DIRECTIONS order for fallbacks", () => {
    expect(DIRECTIONS).toEqual(["up", "right", "down", "left"]);
  });
});
