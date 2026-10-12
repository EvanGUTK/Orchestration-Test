import { describe, expect, it } from "vitest";
import {
  CLASSIC_RULES, addDecimal, canonicalStateJson, compareDecimal, customRules, formatTile,
  isDecimal, isExponent, resolveRules, tileValue, ENGINE_VERSION,
} from "../src/index.ts";
import type { GameState } from "../src/index.ts";

describe("exact helpers", () => {
  it("validates canonical decimals", () => {
    expect(isDecimal("0")).toBe(true);
    expect(isDecimal("01")).toBe(false);
    expect(isDecimal("-1")).toBe(false);
    expect(isDecimal("1.5")).toBe(false);
    expect(isExponent("0")).toBe(false);
    expect(isExponent("4096")).toBe(true);
  });
  it("orders decimals by length then lexically, past 2^53", () => {
    expect(compareDecimal("9", "10")).toBe(-1);
    expect(compareDecimal("18014398509481984", "18014398509481985")).toBe(-1);
    expect(compareDecimal("5", "5")).toBe(0);
  });
  it("computes tiles exactly", () => {
    expect(tileValue("54")).toBe("18014398509481984");
    expect(tileValue("256")).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129639936",
    );
    expect(addDecimal("18014398509481984", "1")).toBe("18014398509481985");
    expect(() => tileValue("99999999")).toThrow(RangeError);
    expect(formatTile("4096")).toBe("2^4096");
    expect(formatTile("11")).toBe("2048");
  });
});

describe("rulesets", () => {
  it("round-trips custom rules by version id", () => {
    const r = customRules({ boardSize: 5, spawnFourTenths: 3 });
    expect(resolveRules(r.version)).toEqual(r);
    expect(resolveRules("classic-v1")).toEqual(CLASSIC_RULES);
    expect(resolveRules("custom-v1:9:1:2:none")).toBeNull();
    expect(() => customRules({ boardSize: 2 })).toThrow();
  });
});

describe("canonical state json", () => {
  it("has the frozen key order and no whitespace", () => {
    const state: GameState = {
      schemaVersion: 1, engineVersion: ENGINE_VERSION, rulesetVersion: "classic-v1",
      board: { size: 3, cells: ["1", null, "256", null, null, null, null, null, null] },
      score: "18014398509481984", acceptedMoves: 3, revision: 3,
      rng: { algorithm: "xoshiro128ss-v1", words: [1, 2, 3, 4294967295] },
      status: "active", celebrated2048: false,
    };
    expect(canonicalStateJson(state)).toBe(
      '{"schemaVersion":1,"engineVersion":"engine-1.0.0","rulesetVersion":"classic-v1",' +
        '"board":{"size":3,"cells":["1",null,"256",null,null,null,null,null,null]},' +
        '"score":"18014398509481984","acceptedMoves":3,"revision":3,' +
        '"rng":{"algorithm":"xoshiro128ss-v1","words":[1,2,3,4294967295]},' +
        '"status":"active","celebrated2048":false}',
    );
  });
});
