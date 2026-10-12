import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CompetitionError } from "./errors.js";
import { computeHumanVsBotBoard } from "./human-vs-bot.js";
import type { HumanVsBotGame } from "./human-vs-bot.js";

const ex = { strategy: "expectimax-v1", botVersion: "bots-1.1.0" } as const;
const gr = { strategy: "greedy-v1", botVersion: "bots-1.1.0" } as const;
const HUGE = (2n ** 64n + 7n).toString();
const HUGE_MINUS = (2n ** 64n + 6n).toString();

function game(
  matchId: string,
  accountId: string,
  bot: HumanVsBotGame["bot"],
  result: HumanVsBotGame["result"],
  humanScore: string,
  humanMaxExponent: string | null = "8",
): HumanVsBotGame {
  return { matchId, accountId, bot, result, humanScore, humanMaxExponent };
}

describe("computeHumanVsBotBoard", () => {
  const board = computeHumanVsBotBoard([
    game("m1", "alice", ex, "loss", "4000"),
    game("m2", "alice", ex, "win", HUGE, "64"),
    game("m3", "bob", ex, "win", "900"),
    game("m4", "bob", ex, "draw", "800"),
    game("m5", "carol", ex, "win", HUGE_MINUS, "64"),
    game("m6", "alice", gr, "win", "3000"),
  ]);

  it("tallies per account and opponent bot with exact best scores", () => {
    expect(board.map((r) => [r.opponent, r.rank, r.accountId, r.won, r.drawn, r.lost, r.bestScore])).toEqual([
      ["expectimax-v1@bots-1.1.0", 1, "bob", 1, 1, 0, "900"],
      ["expectimax-v1@bots-1.1.0", 2, "alice", 1, 0, 1, HUGE],
      ["expectimax-v1@bots-1.1.0", 3, "carol", 1, 0, 0, HUGE_MINUS],
      ["greedy-v1@bots-1.1.0", 1, "alice", 1, 0, 0, "3000"],
    ]);
    expect(board[1]).toMatchObject({ played: 2, bestScoreMatchId: "m2", bestMaxExponent: "64" });
  });

  it("orders equal records by exact best score above 2^53", () => {
    const rows = computeHumanVsBotBoard([
      game("a", "x", ex, "win", HUGE_MINUS),
      game("b", "y", ex, "win", HUGE),
    ]);
    expect(rows.map((r) => r.accountId)).toEqual(["y", "x"]);
  });

  it("is independent of input order", () => {
    const games = [
      game("m1", "alice", ex, "loss", "4000"),
      game("m2", "bob", ex, "win", "4000"),
      game("m3", "alice", gr, "draw", "10"),
      game("m4", "carol", ex, "win", "4000"),
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(games, { minLength: 4, maxLength: 4 }), (shuffled) => {
        expect(computeHumanVsBotBoard(shuffled)).toEqual(computeHumanVsBotBoard(games));
      }),
    );
  });

  it("rejects duplicate matches and malformed input", () => {
    expect(() =>
      computeHumanVsBotBoard([game("m", "a", ex, "win", "1"), game("m", "a", ex, "win", "1")]),
    ).toThrow(CompetitionError);
    expect(() => computeHumanVsBotBoard([game("m", "a", ex, "win", "1.0")])).toThrow(CompetitionError);
    expect(() => computeHumanVsBotBoard([game("m", "", ex, "win", "1")])).toThrow(CompetitionError);
    expect(() =>
      computeHumanVsBotBoard([game("m", "a", ex, "timeout" as HumanVsBotGame["result"], "1")]),
    ).toThrow(CompetitionError);
    expect(computeHumanVsBotBoard([])).toEqual([]);
  });
});
