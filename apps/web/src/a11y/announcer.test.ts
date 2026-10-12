import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Announcer } from "./announcer.js";

describe("Announcer throttling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const spoken: string[] = [];
    const a = new Announcer({ intervalMs: 1000, now: () => Date.now() });
    a.subscribe((m) => spoken.push(m));
    return { a, spoken };
  };

  it("speaks the first message immediately and coalesces a burst into one update", () => {
    const { a, spoken } = make();
    a.announce("Score 4");
    for (let i = 1; i <= 50; i++) a.announce(`Score ${4 + i * 4}`); // 50 moves within one animation burst
    expect(spoken).toEqual(["Score 4"]);
    vi.advanceTimersByTime(999);
    expect(spoken).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(spoken).toEqual(["Score 4", "Score 204"]);
  });

  it("never drops important messages and speaks them before the latest score", () => {
    const { a, spoken } = make();
    a.announce("Score 4");
    a.announce("Score 8");
    a.announce("New highest tile: 2048", "important");
    a.announce("Score 12");
    a.announce("Game over. Final score 12", "important");
    vi.advanceTimersByTime(1000);
    expect(spoken).toEqual(["Score 4", "New highest tile: 2048. Game over. Final score 12. Score 12"]);
  });

  it("limits the update rate under sustained input", () => {
    const { a, spoken } = make();
    for (let t = 0; t < 5000; t += 16) {
      a.announce(`Score ${t}`);
      vi.advanceTimersByTime(16);
    }
    // ~5 seconds of 60fps updates -> about one announcement per second.
    expect(spoken.length).toBeGreaterThanOrEqual(5);
    expect(spoken.length).toBeLessThanOrEqual(6);
  });

  it("cancel drops pending messages", () => {
    const { a, spoken } = make();
    a.announce("one");
    a.announce("two");
    a.cancel();
    vi.advanceTimersByTime(2000);
    expect(spoken).toEqual(["one"]);
  });
});
