import { LIMITS } from "@g2048/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDecimal,
  compareDecimal,
  isDecimal,
  isExponent,
  MAX_EXPONENT,
  nextExponent,
  pow2Decimal,
} from "./decimal.js";
import { EngineError } from "./errors.js";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof EngineError ? error.code : "RAW";
  }
}

describe("canonical decimals", () => {
  it("accepts only canonical nonnegative integers", () => {
    for (const ok of ["0", "1", "10", "18014398509481984", "9".repeat(400)]) expect(isDecimal(ok)).toBe(true);
    for (const bad of ["", "01", "-1", "1.0", "1e3", " 1", "1 ", "+1", "0x10", "١", 1, null, undefined, 1n]) {
      expect(isDecimal(bad)).toBe(false);
    }
    expect(isExponent("0")).toBe(false);
    expect(isExponent("1")).toBe(true);
    expect(isExponent("011")).toBe(false);
  });

  it("compares exactly beyond 2^53", () => {
    expect(compareDecimal("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareDecimal("9007199254740992", "9007199254740993")).toBe(-1);
    expect(compareDecimal("123", "123")).toBe(0);
    expect(compareDecimal("99", "100")).toBe(-1);
    expect(compareDecimal("0", "1")).toBe(-1);
  });

  it("adds exactly beyond 2^53", () => {
    expect(addDecimal("9007199254740992", "1")).toBe("9007199254740993");
    expect(addDecimal("0", "0")).toBe("0");
    expect(addDecimal("0", "5")).toBe("5");
    expect(addDecimal("99999999999999999999", "1")).toBe("100000000000000000000");
  });

  it("rejects non-canonical operands with VALIDATION_ERROR", () => {
    expect(codeOf(() => addDecimal("01", "1"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => compareDecimal("1", "-1"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => pow2Decimal("0"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => addDecimal(5 as unknown as string, "1"))).toBe("VALIDATION_ERROR");
  });

  it("matches BigInt for random operands", () => {
    const big = fc.bigInt({ min: 0n, max: 1n << 300n });
    fc.assert(
      fc.property(big, big, (a, b) => {
        expect(addDecimal(a.toString(), b.toString())).toBe((a + b).toString());
        const expected = a === b ? 0 : a < b ? -1 : 1;
        expect(compareDecimal(a.toString(), b.toString())).toBe(expected);
      }),
    );
  });

  it("computes powers of two exactly", () => {
    expect(pow2Decimal("1")).toBe("2");
    expect(pow2Decimal("11")).toBe("2048");
    expect(pow2Decimal("54")).toBe("18014398509481984");
    expect(pow2Decimal("256")).toBe((2n ** 256n).toString());
    expect(pow2Decimal("4096")).toBe((2n ** 4096n).toString());
    expect(pow2Decimal("4096")).toHaveLength(1234);
  });

  it("guards LIMITS.maxExponent before computing a power", () => {
    expect(MAX_EXPONENT).toBe(String(LIMITS.maxExponent));
    expect(codeOf(() => pow2Decimal("1000001"))).toBe("RESOURCE_LIMIT");
    expect(codeOf(() => pow2Decimal("9".repeat(5000)))).toBe("RESOURCE_LIMIT");
    expect(codeOf(() => nextExponent(MAX_EXPONENT))).toBe("RESOURCE_LIMIT");
  });

  it("increments exponent strings with carries", () => {
    expect(nextExponent("1")).toBe("2");
    expect(nextExponent("9")).toBe("10");
    expect(nextExponent("199")).toBe("200");
    expect(nextExponent("999")).toBe("1000");
    expect(nextExponent("4095")).toBe("4096");
    expect(nextExponent("99999")).toBe("100000");
  });
});
