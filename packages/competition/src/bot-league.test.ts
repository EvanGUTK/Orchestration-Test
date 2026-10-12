import type { BotStrategy, DuelOutcome } from "@g2048/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { botLeagueKey, computeBotLeague, truncatedQuotient } from "./bot-league.js";
import type { BotLeagueGame, BotLeagueSeat } from "./bot-league.js";
import { CompetitionError } from "./errors.js";

function bot(
  strategy: BotStrategy,
  score: string,
  nodeBudget = 100,
  botVersion = "bots-1.0.0",
): BotLeagueSeat {
  return { kind: "bot", strategy, botVersion, nodeBudget, score, maxExponent: score === "0" ? null : "5" };
}
const game = (a: BotLeagueSeat, b: BotLeagueSeat, outcome: DuelOutcome): BotLeagueGame => ({ a, b, outcome });
const HUGE = (2n ** 70n).toString();

describe("computeBotLeague", () => {
  it("tallies W/D/L, exact points, total and average score", () => {
    const rows = computeBotLeague([
      game(bot("expectimax-v1", "9000"), bot("random-v1", "1000"), "seat-a"),
      game(bot("expectimax-v1", "8000"), bot("greedy-v1", "8000"), "draw"),
      game(bot("greedy-v1", "3000"), bot("random-v1", "900"), "seat-a"),
      game(bot("random-v1", "1001"), bot("expectimax-v1", "7001"), "seat-b"),
    ]);
    expect(rows.map((r) => [r.rank, r.key, r.points, r.won, r.drawn, r.lost])).toEqual([
      [1, "expectimax-v1@bots-1.0.0/100", "2.5", 2, 1, 0],
      [2, "greedy-v1@bots-1.0.0/100", "1.5", 1, 1, 0],
      [3, "random-v1@bots-1.0.0/100", "0", 0, 0, 3],
    ]);
    expect(rows[0]).toMatchObject({
      totalScore: "24001",
      averageScore: "8000.33",
      bestScore: "9000",
      played: 3,
    });
    expect(rows[2]?.averageScore).toBe("967.00");
  });

  it("treats a different budget or bot version as a different entrant", () => {
    const rows = computeBotLeague([
      game(bot("expectimax-v1", "10", 100), bot("expectimax-v1", "10", 5000), "draw"),
      game(bot("expectimax-v1", "10", 100, "bots-2.0.0"), bot("expectimax-v1", "10", 100), "draw"),
    ]);
    expect(rows.map((r) => r.key).sort()).toEqual([
      "expectimax-v1@bots-1.0.0/100",
      "expectimax-v1@bots-1.0.0/5000",
      "expectimax-v1@bots-2.0.0/100",
    ]);
  });

  it("breaks ties by wins, then exact average score above 2^53, then key", () => {
    const big = (2n ** 60n + 1n).toString();
    const less = (2n ** 60n).toString();
    const rows = computeBotLeague([
      game(bot("heuristic-v1", big), bot("greedy-v1", less), "draw"),
      game(bot("random-v1", "5"), bot("random-v1", "5", 7), "draw"),
    ]);
    expect(rows.map((r) => r.key)).toEqual([
      "heuristic-v1@bots-1.0.0/100",
      "greedy-v1@bots-1.0.0/100",
      "random-v1@bots-1.0.0/100",
      "random-v1@bots-1.0.0/7",
    ]);
    expect(rows[0]?.averageScore).toBe(`${big}.00`);
  });

  it("keeps huge totals exact", () => {
    const rows = computeBotLeague([
      game(bot("expectimax-v1", HUGE), bot("random-v1", "0"), "seat-a"),
      game(bot("expectimax-v1", HUGE), bot("random-v1", "0"), "seat-a"),
    ]);
    expect(rows[0]?.totalScore).toBe((2n ** 71n).toString());
    expect(rows[1]?.bestMaxExponent).toBeNull();
  });

  it("rejects human seats so bot results never mix with human ladders", () => {
    const human = { kind: "human", accountId: "acc" } as unknown as BotLeagueSeat;
    expect(() => computeBotLeague([game(human, bot("random-v1", "1"), "seat-a")])).toThrow(CompetitionError);
    expect(() => computeBotLeague([game(bot("random-v1", "1"), bot("random-v1", "01"), "seat-a")])).toThrow(
      CompetitionError,
    );
    expect(() =>
      computeBotLeague([game(bot("random-v1", "1"), bot("random-v1", "1"), "timeout" as DuelOutcome)]),
    ).toThrow(CompetitionError);
  });

  it("is order-independent and conserves games played", () => {
    const strategies: BotStrategy[] = ["random-v1", "greedy-v1", "heuristic-v1", "expectimax-v1"];
    const arbGame = fc
      .tuple(
        fc.constantFrom(...strategies),
        fc.constantFrom(...strategies),
        fc.bigInt({ min: 0n, max: 2n ** 80n }),
        fc.bigInt({ min: 0n, max: 2n ** 80n }),
        fc.constantFrom<DuelOutcome>("seat-a", "seat-b", "draw"),
      )
      .map(([sa, sb, a, b, o]) => game(bot(sa, a.toString()), bot(sb, b.toString(), 200), o));
    fc.assert(
      fc.property(fc.array(arbGame, { maxLength: 30 }), fc.nat(), (games, rot) => {
        const rotated =
          games.length === 0
            ? games
            : [...games.slice(rot % games.length), ...games.slice(0, rot % games.length)];
        const a = computeBotLeague(games);
        expect(computeBotLeague(rotated)).toEqual(a);
        expect(a.reduce((n, r) => n + r.played, 0)).toBe(2 * games.length);
        expect(a.reduce((n, r) => n + r.halfPoints, 0)).toBe(2 * games.length);
      }),
      { numRuns: 200 },
    );
  });

  it("formats exact quotients", () => {
    expect(truncatedQuotient(10n, 3, 2)).toBe("3.33");
    expect(truncatedQuotient(2n, 3, 2)).toBe("0.66");
    expect(truncatedQuotient(7n, 0, 2)).toBe("0.00");
    expect(truncatedQuotient(7n, 2, 0)).toBe("3");
    expect(botLeagueKey({ strategy: "random-v1", botVersion: "v", nodeBudget: 1 })).toBe("random-v1@v/1");
  });
});
