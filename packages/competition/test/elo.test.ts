import { describe, expect, it } from "vitest";
import { ELO_K, ELO_START_RATING, applyElo, eloDeltaForA, expectedScore, rateMatch, ratingEventKey, roundHalfAwayFromZero } from "../src/index.ts";

describe("elo-v1", () => {
  it("has the frozen parameters", () => {
    expect(ELO_START_RATING).toBe(1000);
    expect(ELO_K).toBe(24);
  });

  it("expected score matches the standard formula", () => {
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1400, 1000)).toBeCloseTo(0.9090909, 6);
    expect(expectedScore(1000, 1400)).toBeCloseTo(0.0909091, 6);
    expect(expectedScore(1200, 1000) + expectedScore(1000, 1200)).toBeCloseTo(1, 12);
  });

  it("equal ratings: win +12 / -12, draw 0", () => {
    expect(applyElo(1000, 1000, 1)).toEqual({ deltaA: 12, deltaB: -12, afterA: 1012, afterB: 988 });
    expect(applyElo(1000, 1000, 0)).toEqual({ deltaA: -12, deltaB: 12, afterA: 988, afterB: 1012 });
    expect(applyElo(1000, 1000, 0.5)).toEqual({ deltaA: 0, deltaB: 0, afterA: 1000, afterB: 1000 });
  });

  it("known vectors", () => {
    // E = 0.6401; 24 * 0.3599 = 8.64 -> 9
    expect(eloDeltaForA(1100, 1000, 1)).toBe(9);
    expect(applyElo(1100, 1000, 0)).toMatchObject({ deltaA: -15, deltaB: 15 });
    // underdog win: E = 0.0909 -> 24 * 0.9091 = 21.8 -> 22
    expect(applyElo(1000, 1400, 1)).toMatchObject({ deltaA: 22, deltaB: -22 });
    // underdog draw: 24 * (0.5 - 0.0909) = 9.82 -> 10
    expect(applyElo(1000, 1400, 0.5)).toMatchObject({ deltaA: 10, deltaB: -10 });
  });

  it("conserves total rating for every rating pair and outcome (grid)", () => {
    for (let a = 400; a <= 2400; a += 37) {
      for (let b = 400; b <= 2400; b += 41) {
        for (const s of [0, 0.5, 1] as const) {
          const r = applyElo(a, b, s);
          expect(r.afterA + r.afterB).toBe(a + b);
          expect(r.deltaA + r.deltaB).toBe(0);
          expect(Number.isInteger(r.deltaA)).toBe(true);
          expect(Math.abs(r.deltaA)).toBeLessThanOrEqual(ELO_K);
        }
      }
    }
  });

  it("never yields -0", () => {
    const r = applyElo(1000, 1000, 0.5);
    expect(Object.is(r.deltaA, -0)).toBe(false);
    expect(Object.is(r.deltaB, -0)).toBe(false);
    expect(Object.is(roundHalfAwayFromZero(-0.2), -0)).toBe(false);
  });

  it("rounds half away from zero symmetrically", () => {
    expect(roundHalfAwayFromZero(12.5)).toBe(13);
    expect(roundHalfAwayFromZero(-12.5)).toBe(-13);
    expect(roundHalfAwayFromZero(0.49999)).toBe(0);
    expect(roundHalfAwayFromZero(2.4999999999999)).toBe(3); // snapped to 9 decimals first
  });

  it("rejects non-integer ratings", () => {
    expect(() => expectedScore(1000.5, 1000)).toThrow();
    expect(() => expectedScore(Number.NaN, 1000)).toThrow();
  });

  it("builds two idempotent rating events", () => {
    const [e0, e1] = rateMatch({ matchId: "m1", seasonId: "s2026-10", rulesetVersion: "duel-v1", seat0: { accountId: "u1", rating: 1000 }, seat1: { accountId: "u2", rating: 1000 }, outcome: "seat0" });
    expect(e0).toEqual({ matchId: "m1", accountId: "u1", seasonId: "s2026-10", rulesetVersion: "duel-v1", before: 1000, after: 1012, delta: 12, outcome: 1, idempotencyKey: "elo-v1:m1:u1", algorithm: "elo-v1" });
    expect(e1).toMatchObject({ accountId: "u2", before: 1000, after: 988, delta: -12, outcome: 0, idempotencyKey: "elo-v1:m1:u2" });
    expect(e0.delta + e1.delta).toBe(0);
    expect(ratingEventKey("m1", "u1")).toBe(e0.idempotencyKey);
    expect(rateMatch({ matchId: "m1", seasonId: "s2026-10", rulesetVersion: "duel-v1", seat0: { accountId: "u1", rating: 1000 }, seat1: { accountId: "u2", rating: 1000 }, outcome: "seat0" })).toEqual([e0, e1]);
  });

  it("draw and seat1 win outcomes", () => {
    const [d0, d1] = rateMatch({ matchId: "m", seasonId: "s", rulesetVersion: "duel-v1", seat0: { accountId: "a", rating: 1200 }, seat1: { accountId: "b", rating: 1000 }, outcome: "draw" });
    expect([d0.outcome, d1.outcome]).toEqual([0.5, 0.5]);
    expect(d0.delta).toBeLessThan(0);
    expect(d0.delta + d1.delta).toBe(0);
    const [w0, w1] = rateMatch({ matchId: "m", seasonId: "s", rulesetVersion: "duel-v1", seat0: { accountId: "a", rating: 1000 }, seat1: { accountId: "b", rating: 1000 }, outcome: "seat1" });
    expect([w0.outcome, w1.outcome]).toEqual([0, 1]);
  });

  it("refuses to rate an account against itself", () => {
    expect(() => rateMatch({ matchId: "m", seasonId: "s", rulesetVersion: "duel-v1", seat0: { accountId: "a", rating: 1000 }, seat1: { accountId: "a", rating: 1000 }, outcome: "draw" })).toThrow(/itself/);
  });
});
