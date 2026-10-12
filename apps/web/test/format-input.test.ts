import { describe, expect, it } from "vitest";
import { compactDecimal, groupDecimal, tileLabel, tileSpoken } from "../src/format.ts";
import { DEFAULT_KEY_BINDINGS, directionForKey, parseBindingText, sanitiseBindings } from "../src/input/keys.ts";
import { classifySwipe } from "../src/input/swipe.ts";
import { normalisePreferences } from "../src/state/prefs.ts";
import { validateRegistration } from "../src/screens/Auth.tsx";
import { validatePractice } from "../src/screens/Lists.tsx";
import { parseHash } from "../src/router.tsx";

describe("exact value formatting", () => {
  it("groups decimals above 2^53 without losing digits", () => {
    const score = "123456789012345678901234567890";
    expect(groupDecimal(score, ",").replaceAll(",", "")).toBe(score);
    expect(groupDecimal("9007199254740993", ",")).toBe("9,007,199,254,740,993");
    expect(groupDecimal("12")).toBe("12");
  });

  it("compacts very long scores but keeps leading digits and digit count", () => {
    const huge = "9".repeat(5000);
    expect(compactDecimal(huge)).toBe("9.99999e+4999");
    expect(groupDecimal(huge)).toBe("9.99999e+4999");
    expect(groupDecimal("9".repeat(31))).toBe("9.99999e+30");
    expect(groupDecimal("9".repeat(30), ",").replaceAll(",", "")).toBe("9".repeat(30));
  });

  it("renders full decimals up to exponent 39 and 2^n beyond", () => {
    expect(tileLabel("11", "numbers")).toBe("2048");
    expect(tileLabel("39", "numbers")).toBe("549755813888");
    expect(tileLabel("40", "numbers-pattern")).toBe("2^40");
    expect(tileLabel("4096", "numbers")).toBe("2^4096");
    expect(tileLabel("3", "powers")).toBe("2^3");
  });

  it("speaks big tiles without reading thousands of digits", () => {
    expect(tileSpoken("11")).toBe("2048");
    expect(tileSpoken("4096")).toBe("2 to the power 4096");
  });
});

describe("keyboard mapping", () => {
  it("maps arrows and WASD", () => {
    expect(directionForKey({ key: "ArrowUp" })).toBe("up");
    expect(directionForKey({ key: "a" })).toBe("left");
    expect(directionForKey({ key: "D" })).toBe("right");
    expect(directionForKey({ key: "s" })).toBe("down");
  });
  it("ignores other keys and modified shortcuts", () => {
    expect(directionForKey({ key: "Tab" })).toBeNull();
    expect(directionForKey({ key: " " })).toBeNull();
    expect(directionForKey({ key: "ArrowLeft", metaKey: true })).toBeNull();
    expect(directionForKey({ key: "a", ctrlKey: true })).toBeNull();
  });
  it("supports custom bindings and sanitises bad input", () => {
    const custom = { ...DEFAULT_KEY_BINDINGS, left: ["h"] };
    expect(directionForKey({ key: "h" }, custom)).toBe("left");
    expect(directionForKey({ key: "a" }, custom)).toBeNull();
    expect(sanitiseBindings({ up: [], right: "x", down: ["j"] }).up).toEqual(DEFAULT_KEY_BINDINGS.up);
    expect(sanitiseBindings({ down: ["j"] }).down).toEqual(["j"]);
    expect(parseBindingText(" ArrowUp, w ,, k ")).toEqual(["ArrowUp", "w", "k"]);
  });
});

describe("swipe classification", () => {
  it("accepts clear swipes in each direction", () => {
    expect(classifySwipe(60, 5, 200)).toBe("right");
    expect(classifySwipe(-60, 5, 200)).toBe("left");
    expect(classifySwipe(3, 70, 200)).toBe("down");
    expect(classifySwipe(3, -70, 200)).toBe("up");
  });
  it("rejects taps, slow drags and diagonals", () => {
    expect(classifySwipe(5, 5, 100)).toBeNull();
    expect(classifySwipe(80, 0, 5000)).toBeNull();
    expect(classifySwipe(50, 45, 200)).toBeNull();
  });
});

describe("preferences and routing", () => {
  it("normalises unknown preference values to defaults", () => {
    const prefs = normalisePreferences({ theme: "neon", motion: "reduced", soundMuted: "yes" });
    expect(prefs.theme).toBe("system");
    expect(prefs.motion).toBe("reduced");
    expect(prefs.soundMuted).toBe(false);
    expect(prefs.keyBindings.up).toEqual(DEFAULT_KEY_BINDINGS.up);
  });
  it("parses hash routes with params and encoded segments", () => {
    const route = parseHash("#/play/ab%20c?size=5&seed=x");
    expect(route.segments).toEqual(["play", "ab c"]);
    expect(route.params.get("size")).toBe("5");
    expect(parseHash("").segments).toEqual([]);
  });
});

describe("form validation", () => {
  it("validates registration against the shared rules", () => {
    expect(validateRegistration({ username: "ab", displayName: "", password: "short" })).toEqual({
      username: expect.any(String),
      displayName: expect.any(String),
      password: expect.any(String),
    });
    expect(validateRegistration({ username: "Alice_01", displayName: "Alice \u{1F600}", password: "x".repeat(12) })).toEqual({});
    expect(validateRegistration({ username: "bad name", displayName: "x", password: "x".repeat(129) })).toHaveProperty("password");
  });
  it("validates practice settings", () => {
    expect(validatePractice({ size: "2", fours: "1", seed: "" })).toHaveProperty("size");
    expect(validatePractice({ size: "9", fours: "1", seed: "" })).toHaveProperty("size");
    expect(validatePractice({ size: "4.5", fours: "1", seed: "" })).toHaveProperty("size");
    expect(validatePractice({ size: "8", fours: "11", seed: "" })).toHaveProperty("fours");
    expect(validatePractice({ size: "3", fours: "0", seed: "abc" })).toEqual({});
  });
});
