import { describe, expect, it } from "vitest";
import { compareDecimal, groupDigits, pow2Decimal, pow2DigitCount } from "./decimal.js";
import { formatScore, tileDisplay } from "./format.js";

describe("exact tile formatting", () => {
  it("shows small tiles as decimals and switches to 2^n above 6 digits in auto mode", () => {
    expect(tileDisplay("11").text).toBe("2048");
    expect(tileDisplay("19")).toMatchObject({ kind: "decimal", text: "524288" });
    expect(tileDisplay("20")).toMatchObject({ kind: "power", text: "2^20" });
    expect(tileDisplay("20").title).toBe("2^20 = 1048576");
  });

  it("honours the tile display styles", () => {
    expect(tileDisplay("39", "value")).toMatchObject({ kind: "decimal", text: "549755813888" });
    expect(tileDisplay("40", "value").kind).toBe("power");
    expect(tileDisplay("1", "exponent")).toMatchObject({ kind: "power", text: "2^1" });
  });

  it("renders exponent 4096 as 2^4096 with the exact 1234-digit decimal in its tooltip", () => {
    const exact = (1n << 4096n).toString();
    const d = tileDisplay("4096");
    expect(d.kind).toBe("power");
    expect(d.text).toBe("2^4096");
    expect(d.digits).toBe(1234n);
    expect(d.title).toBe(`2^4096 = ${exact}`);
    expect(d.ariaLabel).toBe("2 to the power 4096, a 1,234-digit number");
  });

  it("does not expand astronomically large exponents but still reports exact digit counts", () => {
    expect(pow2Decimal("1000000")).toBeNull();
    expect(pow2DigitCount("1000000")).toBe(301030n);
    // Log-based count agrees with BigInt expansion just past the expansion cut-off.
    expect(pow2DigitCount("20001")).toBe(BigInt((1n << 20001n).toString().length));
    const d = tileDisplay("1000000");
    expect(d.text).toBe("2^1000000");
    expect(d.title).toContain("301,030 digits");
  });

  it("rejects non-canonical exponents", () => {
    expect(() => tileDisplay("0")).toThrow();
    expect(() => tileDisplay("1e3")).toThrow();
  });
});

describe("exact score formatting", () => {
  it("groups digits without numeric parsing", () => {
    expect(groupDigits("0")).toBe("0");
    expect(groupDigits("1234567")).toBe("1,234,567");
    expect(formatScore("999999999999999").short).toBe("999,999,999,999,999");
  });

  it("keeps scores far above 2^53 exact", () => {
    const big = (2n ** 64n + 1n).toString(); // 18446744073709551617, not representable as a double
    const s = formatScore(big);
    expect(s.exact).toBe("18446744073709551617");
    expect(s.truncated).toBe(true);
    expect(s.short).toBe("1.84467… × 10^19");
  });

  it("handles huge score strings", () => {
    const huge = "7" + "0".repeat(2999);
    const s = formatScore(huge);
    expect(s.digits).toBe(3000);
    expect(s.exact).toBe(huge);
    expect(s.spoken).toContain("3000-digit");
  });

  it("compares decimals exactly", () => {
    expect(compareDecimal("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareDecimal("10", "9")).toBe(1);
    expect(compareDecimal("5", "5")).toBe(0);
  });
});
