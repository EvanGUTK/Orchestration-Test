import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CompetitionError } from "./errors.js";
import { eloDelta, expectedScore, roundHalfAwayFromZero } from "./elo.js";
import type { EloOutcome } from "./elo.js";

const outcome = fc.constantFrom<EloOutcome>(1, 0.5, 0);
const rating = fc.integer({ min: -2000, max: 6000 });
const wideRating = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });

describe("eloDelta known values", () => {
  it("1000 vs 1000: win +12/-12, draw 0/0, loss -12/+12", () => {
    expect(eloDelta(1000, 1000, 1)).toEqual({ deltaA: 12, deltaB: -12 });
    expect(eloDelta(1000, 1000, 0.5)).toEqual({ deltaA: 0, deltaB: 0 });
    expect(eloDelta(1000, 1000, 0)).toEqual({ deltaA: -12, deltaB: 12 });
  });

  it("matches hand-computed values for unequal ratings", () => {
    // expected(1200 vs 1000) = 0.7597469...; 24 * 0.2402531 = 5.766 -> 6
    expect(eloDelta(1200, 1000, 1)).toEqual({ deltaA: 6, deltaB: -6 });
    expect(eloDelta(1200, 1000, 0.5)).toEqual({ deltaA: -6, deltaB: 6 }); // -6.234
    expect(eloDelta(1200, 1000, 0)).toEqual({ deltaA: -18, deltaB: 18 }); // -18.234
    // expected(1000 vs 1400) = 1/11; 24 * 10/11 = 21.818 -> 22
    expect(eloDelta(1000, 1400, 1)).toEqual({ deltaA: 22, deltaB: -22 });
    expect(eloDelta(1400, 1000, 0)).toEqual({ deltaA: -22, deltaB: 22 });
  });

  it("returns exact 0 (never -0) for negligible deltas", () => {
    const { deltaA, deltaB } = eloDelta(4000, 0, 1);
    expect(Object.is(deltaA, 0)).toBe(true);
    expect(Object.is(deltaB, 0)).toBe(true);
    expect(eloDelta(0, 4000, 1)).toEqual({ deltaA: 24, deltaB: -24 });
  });

  it("expectedScore follows 1/(1+10^((opp-r)/400))", () => {
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1000, 1400)).toBeCloseTo(1 / 11, 15);
  });

  it("rejects non-integer ratings and unknown outcomes", () => {
    expect(() => eloDelta(1000.5, 1000, 1)).toThrow(CompetitionError);
    expect(() => eloDelta(1000, Number.NaN, 1)).toThrow(CompetitionError);
    expect(() => eloDelta(1000, 2 ** 53, 1)).toThrow(CompetitionError);
    expect(() => eloDelta(1000, 1000, 0.25 as EloOutcome)).toThrow(CompetitionError);
  });
});

describe("roundHalfAwayFromZero", () => {
  it("rounds halves away from zero symmetrically", () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(11.4999)).toBe(11);
    expect(roundHalfAwayFromZero(-11.4999)).toBe(-11);
  });

  it("avoids the x + 0.5 floating-point trap", () => {
    expect(roundHalfAwayFromZero(0.49999999999999994)).toBe(0);
    expect(roundHalfAwayFromZero(-0.49999999999999994)).toBe(0);
    expect(Object.is(roundHalfAwayFromZero(-0.2), 0)).toBe(true);
  });

  it("is odd: round(-x) === -round(x)", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (x) => {
        expect(roundHalfAwayFromZero(-x) + roundHalfAwayFromZero(x)).toBe(0);
      }),
    );
  });
});

describe("eloDelta properties", () => {
  it("conserves combined rating and yields integers in [-24, 24]", () => {
    fc.assert(
      fc.property(rating, rating, outcome, (ra, rb, o) => {
        const { deltaA, deltaB } = eloDelta(ra, rb, o);
        expect(Number.isInteger(deltaA)).toBe(true);
        expect(deltaA + deltaB).toBe(0);
        expect(ra + deltaA + (rb + deltaB)).toBe(ra + rb);
        expect(Math.abs(deltaA)).toBeLessThanOrEqual(24);
      }),
      { numRuns: 5000 },
    );
  });

  it("is seat-symmetric: swapping seats mirrors the integers exactly", () => {
    fc.assert(
      fc.property(wideRating, wideRating, outcome, (ra, rb, o) => {
        const forward = eloDelta(ra, rb, o);
        const swapped = eloDelta(rb, ra, (1 - o) as EloOutcome);
        expect(swapped.deltaA).toBe(forward.deltaB);
        expect(swapped.deltaB).toBe(forward.deltaA);
      }),
      { numRuns: 5000 },
    );
  });

  it("orders outcomes: win >= draw >= loss, and a win never loses rating", () => {
    fc.assert(
      fc.property(rating, rating, (ra, rb) => {
        const win = eloDelta(ra, rb, 1).deltaA;
        const draw = eloDelta(ra, rb, 0.5).deltaA;
        const loss = eloDelta(ra, rb, 0).deltaA;
        expect(win).toBeGreaterThanOrEqual(draw);
        expect(draw).toBeGreaterThanOrEqual(loss);
        expect(win).toBeGreaterThanOrEqual(0);
        expect(loss).toBeLessThanOrEqual(0);
      }),
      { numRuns: 2000 },
    );
  });

  it("conserves the total rating pool across a long series of matches", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 7 }), fc.nat({ max: 7 }), outcome), { minLength: 1, maxLength: 300 }),
        (games) => {
          const ratings = Array.from({ length: 8 }, () => 1000);
          for (const [i, j, o] of games) {
            if (i === j) continue;
            const { deltaA, deltaB } = eloDelta(ratings[i] as number, ratings[j] as number, o);
            ratings[i] = (ratings[i] as number) + deltaA;
            ratings[j] = (ratings[j] as number) + deltaB;
          }
          expect(ratings.reduce((sum, r) => sum + r, 0)).toBe(8000);
        },
      ),
      { numRuns: 300 },
    );
  });
});
