import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_BINDINGS, directionForKey } from "./keyboard.js";
import { DEFAULT_SWIPE, detectSwipe, SwipeTracker } from "./swipe.js";

describe("key mapping", () => {
  it("maps arrows and WASD (case-insensitive)", () => {
    expect(directionForKey({ key: "ArrowUp" })).toBe("up");
    expect(directionForKey({ key: "d" })).toBe("right");
    expect(directionForKey({ key: "S" })).toBe("down");
    expect(directionForKey({ key: "a" })).toBe("left");
    expect(directionForKey({ key: "x" })).toBeNull();
  });

  it("ignores modified keys so browser shortcuts keep working", () => {
    expect(directionForKey({ key: "a", ctrlKey: true })).toBeNull();
    expect(directionForKey({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(directionForKey({ key: "w", metaKey: true })).toBeNull();
  });

  it("uses custom bindings", () => {
    const bindings = { ...DEFAULT_KEY_BINDINGS, up: ["k"] };
    expect(directionForKey({ key: "k" }, bindings)).toBe("up");
    expect(directionForKey({ key: "ArrowUp" }, bindings)).toBeNull();
  });
});

describe("swipe threshold", () => {
  it("ignores taps and jitter below the minimum distance", () => {
    expect(detectSwipe(0, 0, 50)).toBeNull();
    expect(detectSwipe(DEFAULT_SWIPE.minDistance - 1, 0, 50)).toBeNull();
    expect(detectSwipe(-8, 6, 50)).toBeNull();
  });

  it("detects each direction at the threshold", () => {
    const d = DEFAULT_SWIPE.minDistance;
    expect(detectSwipe(d, 0, 100)).toBe("right");
    expect(detectSwipe(-d, 0, 100)).toBe("left");
    expect(detectSwipe(0, d, 100)).toBe("down");
    expect(detectSwipe(0, -d, 100)).toBe("up");
  });

  it("rejects ambiguous diagonals and slow drags", () => {
    expect(detectSwipe(40, 38, 100)).toBeNull();
    expect(detectSwipe(60, 40, 100)).toBe("right"); // 60 >= 40 * 1.3
    expect(detectSwipe(80, 0, DEFAULT_SWIPE.maxDurationMs + 1)).toBeNull();
  });

  it("tracks a single pointer and ignores multi-touch", () => {
    const t = new SwipeTracker();
    t.down(1, 100, 100, 0);
    expect(t.up(1, 100, 40, 120)).toBe("up");
    t.down(1, 0, 0, 0);
    t.down(2, 50, 50, 10); // second finger cancels the gesture
    expect(t.up(1, 100, 0, 100)).toBeNull();
    t.down(3, 0, 0, 0);
    expect(t.up(4, 100, 0, 100)).toBeNull(); // different pointer
  });
});
