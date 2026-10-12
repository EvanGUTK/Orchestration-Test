import type { SeatResult, SeatTerminalReason } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import { decideDuel, duelOutcomeScores } from "./duel.js";
import { CompetitionError } from "./errors.js";

function seat(score: string, maxExponent: string | null, terminal: SeatTerminalReason | null): SeatResult {
  return { score, maxExponent, terminal };
}

const BIG_A = (2n ** 64n + 1n).toString();
const BIG_B = (2n ** 64n).toString();

describe("decideDuel", () => {
  it("is null until both seats are terminal (one dead board does not end the match)", () => {
    expect(decideDuel(seat("100", "5", "dead-board"), seat("0", null, null))).toBeNull();
    expect(decideDuel(seat("0", null, null), seat("100", "5", "move-cap"))).toBeNull();
    expect(decideDuel(seat("0", null, null), seat("0", null, null))).toBeNull();
    expect(decideDuel(seat("100", "5", null), seat("5", "2", "forfeit"))).toBeNull();
  });

  it("higher score wins; exact comparison far above 2^53", () => {
    expect(decideDuel(seat("200", "5", "dead-board"), seat("100", "9", "move-cap"))).toBe("seat-a");
    expect(decideDuel(seat("100", "9", "move-cap"), seat("200", "5", "dead-board"))).toBe("seat-b");
    expect(Number(BIG_A)).toBe(Number(BIG_B)); // indistinguishable as JS numbers
    expect(decideDuel(seat(BIG_A, "60", "move-cap"), seat(BIG_B, "60", "move-cap"))).toBe("seat-a");
    expect(decideDuel(seat(BIG_B, "60", "move-cap"), seat(BIG_A, "60", "move-cap"))).toBe("seat-b");
  });

  it("equal score falls back to max exponent, then draw", () => {
    expect(decideDuel(seat("500", "8", "move-cap"), seat("500", "7", "dead-board"))).toBe("seat-a");
    expect(decideDuel(seat("500", "7", "move-cap"), seat("500", "10", "move-cap"))).toBe("seat-b");
    expect(decideDuel(seat("500", "8", "move-cap"), seat("500", "8", "dead-board"))).toBe("draw");
    expect(decideDuel(seat("0", null, "dead-board"), seat("0", "1", "dead-board"))).toBe("seat-b");
    expect(decideDuel(seat(BIG_A, "64", "move-cap"), seat(BIG_A, "64", "move-cap"))).toBe("draw");
  });

  it("a forfeiting seat loses regardless of score", () => {
    expect(decideDuel(seat(BIG_A, "64", "forfeit"), seat("0", null, "dead-board"))).toBe("seat-b");
    expect(decideDuel(seat("4", "2", "move-cap"), seat(BIG_A, "64", "forfeit"))).toBe("seat-a");
  });

  it("two forfeits are a draw regardless of score", () => {
    expect(decideDuel(seat(BIG_A, "64", "forfeit"), seat("0", null, "forfeit"))).toBe("draw");
    expect(decideDuel(seat("0", null, "forfeit"), seat("8", "3", "forfeit"))).toBe("draw");
  });

  it("is antisymmetric under seat swap", () => {
    const cases: [SeatResult, SeatResult][] = [
      [seat("1", "1", "move-cap"), seat("2", "1", "move-cap")],
      [seat("2", "3", "forfeit"), seat("2", "1", "dead-board")],
      [seat("2", "3", "forfeit"), seat("2", "1", "forfeit")],
      [seat("7", "3", "dead-board"), seat("7", "3", "move-cap")],
    ];
    const mirror = { "seat-a": "seat-b", "seat-b": "seat-a", draw: "draw" } as const;
    for (const [a, b] of cases) {
      const forward = decideDuel(a, b);
      expect(forward).not.toBeNull();
      expect(decideDuel(b, a)).toBe(mirror[forward as keyof typeof mirror]);
    }
  });

  it("rejects malformed seat results", () => {
    expect(() => decideDuel(seat("01", "1", "move-cap"), seat("1", "1", "move-cap"))).toThrow(
      CompetitionError,
    );
    expect(() => decideDuel(seat("1", "0", "move-cap"), seat("1", "1", "move-cap"))).toThrow(
      CompetitionError,
    );
    expect(() =>
      decideDuel(seat("1", "1", "timeout" as SeatTerminalReason), seat("1", "1", "move-cap")),
    ).toThrow(CompetitionError);
  });

  it("maps outcomes to Elo scores", () => {
    expect(duelOutcomeScores("seat-a")).toEqual({ a: 1, b: 0 });
    expect(duelOutcomeScores("seat-b")).toEqual({ a: 0, b: 1 });
    expect(duelOutcomeScores("draw")).toEqual({ a: 0.5, b: 0.5 });
  });
});
