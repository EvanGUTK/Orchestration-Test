import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareDecimal, compareExponent } from "./decimal.js";
import { CompetitionError } from "./errors.js";
import { compareStanding, sortStandings } from "./standings.js";
import type { Standing } from "./standings.js";

const TWO_POW_53 = (2n ** 53n).toString(); // 9007199254740992
const HUGE = (2n ** 200n).toString();

describe("compareDecimal / compareExponent", () => {
  it("compares by length then lexically, exactly above 2^53", () => {
    expect(compareDecimal("9", "10")).toBe(-1);
    expect(compareDecimal("10", "9")).toBe(1);
    expect(compareDecimal("0", "0")).toBe(0);
    // 2^53 and 2^53 + 1 are the same JS number but distinct decimals.
    expect(Number(TWO_POW_53) === Number("9007199254740993")).toBe(true);
    expect(compareDecimal(TWO_POW_53, "9007199254740993")).toBe(-1);
    expect(compareDecimal(HUGE, `${HUGE.slice(0, -1)}${Number(HUGE.at(-1)) + 1}`)).toBe(-1);
    expect(compareDecimal(HUGE, TWO_POW_53)).toBe(1);
  });

  it("agrees with BigInt ordering for arbitrary values", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 400n }),
        fc.bigInt({ min: 0n, max: 2n ** 400n }),
        (a, b) => {
          const expected = a < b ? -1 : a > b ? 1 : 0;
          expect(compareDecimal(a.toString(), b.toString())).toBe(expected);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("orders null exponent below any exponent", () => {
    expect(compareExponent(null, "1")).toBe(-1);
    expect(compareExponent("1", null)).toBe(1);
    expect(compareExponent(null, null)).toBe(0);
    expect(compareExponent("11", "9")).toBe(1);
    expect(compareExponent("1000000", "999999")).toBe(1);
  });

  it("rejects non-canonical strings", () => {
    for (const bad of ["01", "-1", "1.0", "", " 1", "1e3", "0x10"]) {
      expect(() => compareDecimal(bad, "1")).toThrow(CompetitionError);
    }
    expect(() => compareExponent("0", "1")).toThrow(CompetitionError);
    expect(() => compareExponent("01", "1")).toThrow(CompetitionError);
  });
});

function row(id: string, score: string, maxExponent: string | null, createdAt: string): Standing {
  return { id, score, maxExponent, createdAt };
}

describe("compareStanding (LEADERBOARD_ORDER)", () => {
  const t1 = "2026-10-12T10:00:00.000Z";
  const t2 = "2026-10-12T11:00:00.000Z";

  it("sorts score desc, maxExponent desc, createdAt asc, id asc", () => {
    const rows = [
      row("e", "100", "5", t1),
      row("d", "9007199254740993", "3", t2),
      row("c", "9007199254740992", "20", t1),
      row("b", "100", "6", t2),
      row("a", "100", "6", t2),
      row("f", "100", "6", t1),
      row("g", HUGE, null, t2),
      row("h", "0", null, t1),
    ];
    expect(sortStandings(rows).map((r) => r.id)).toEqual(["g", "d", "c", "f", "a", "b", "e", "h"]);
  });

  it("is stable regardless of input order and does not mutate the input", () => {
    const rows = Object.freeze([
      row("x", "2048", "11", t1),
      row("y", "2048", "11", t1),
      row("z", "4096", "11", t2),
    ]);
    const expected = ["z", "x", "y"];
    fc.assert(
      fc.property(fc.shuffledSubarray([...rows], { minLength: 3, maxLength: 3 }), (shuffled) => {
        expect(sortStandings(shuffled).map((r) => r.id)).toEqual(expected);
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });

  it("is a total order: antisymmetric and zero only for identical keys", () => {
    const arb = fc.record({
      id: fc.constantFrom("a", "b", "c"),
      score: fc.bigInt({ min: 0n, max: 2n ** 70n }).map(String),
      maxExponent: fc.option(fc.integer({ min: 1, max: 30 }).map(String), { nil: null }),
      createdAt: fc.constantFrom(t1, t2),
    });
    fc.assert(
      fc.property(arb, arb, arb, (x, y, z) => {
        expect(compareStanding(x, y)).toBe(-compareStanding(y, x) || 0);
        if (compareStanding(x, y) === 0) expect(x).toEqual(y);
        if (compareStanding(x, y) <= 0 && compareStanding(y, z) <= 0) {
          expect(compareStanding(x, z)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 3000 },
    );
  });
});
