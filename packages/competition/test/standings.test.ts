import { describe, expect, it } from "vitest";
import { boardMaxExponent, compareStanding, rankStandings } from "../src/index.ts";
import type { StandingInput } from "../src/index.ts";

const mk = (attemptId: string, createdOrder: number, score: string, maxExponent: string): StandingInput => ({ attemptId, createdOrder, score, maxExponent });

describe("challenge standings", () => {
  it("sorts score desc using exact decimals beyond 2^53", () => {
    const big = "9007199254740993"; // 2^53 + 1
    const small = "9007199254740992"; // 2^53 (Number() would equate them)
    expect(Number(big)).toBe(Number(small));
    const ranked = rankStandings([mk("a", 1, small, "11"), mk("b", 2, big, "11")]);
    expect(ranked.map((r) => r.attemptId)).toEqual(["b", "a"]);
  });

  it("orders by decimal length before lexical (10 > 9, 1000 > 999)", () => {
    const ranked = rankStandings([mk("a", 1, "999", "5"), mk("b", 2, "1000", "5"), mk("c", 3, "99", "5")]);
    expect(ranked.map((r) => r.attemptId)).toEqual(["b", "a", "c"]);
  });

  it("breaks score ties by max exponent desc, compared exactly", () => {
    const ranked = rankStandings([mk("a", 1, "100", "9"), mk("b", 2, "100", "10"), mk("c", 3, "100", "100")]);
    expect(ranked.map((r) => r.attemptId)).toEqual(["c", "b", "a"]);
  });

  it("breaks full ties by earlier creation order, then attempt id", () => {
    const ranked = rankStandings([mk("z", 3, "100", "9"), mk("a", 2, "100", "9"), mk("m", 2, "100", "9")]);
    expect(ranked.map((r) => r.attemptId)).toEqual(["a", "m", "z"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("does not mutate input and is a total order (antisymmetric)", () => {
    const input = [mk("b", 2, "5", "2"), mk("a", 1, "5", "2")];
    const copy = structuredClone(input);
    rankStandings(input);
    expect(input).toEqual(copy);
    for (const x of input) for (const y of input) expect(Math.sign(compareStanding(x, y)) + Math.sign(compareStanding(y, x))).toBe(0);
  });

  it("is permutation invariant", () => {
    const base = [mk("a", 1, "300", "8"), mk("b", 2, "300", "8"), mk("c", 3, "301", "7"), mk("d", 4, "12345678901234567890123", "50"), mk("e", 5, "300", "9")];
    const expected = rankStandings(base).map((r) => r.attemptId);
    expect(expected).toEqual(["d", "c", "e", "a", "b"]);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...base].sort((x, y) => (x.attemptId.charCodeAt(0) * (i + 3)) % 7 - (y.attemptId.charCodeAt(0) * (i + 3)) % 7);
      expect(rankStandings(shuffled).map((r) => r.attemptId)).toEqual(expected);
    }
  });

  it("computes max exponent of a board exactly", () => {
    expect(boardMaxExponent({ cells: [null, null] })).toBe("0");
    expect(boardMaxExponent({ cells: ["2", "11", null, "9"] })).toBe("11");
    expect(boardMaxExponent({ cells: ["4096", "999", "10000000"] })).toBe("10000000");
  });
});
