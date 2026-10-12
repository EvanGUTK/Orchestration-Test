import { describe, expect, it } from "vitest";
import { outcomeScoreForSeat0, resolveDuel } from "../src/index.ts";
import type { DuelSeat, SeatTerminalReason } from "../src/index.ts";

const seat = (terminalReason: SeatTerminalReason | null, score: string, maxExponent: string): DuelSeat => ({ terminalReason, score, maxExponent });

describe("resolveDuel", () => {
  it("is pending until both seats are terminal", () => {
    const r = resolveDuel(seat("dead", "100", "6"), seat(null, "10", "3"));
    expect(r).toEqual({ status: "pending", outcome: null, decidedBy: null, waitingOn: [1] });
    expect(resolveDuel(seat(null, "1", "1"), seat(null, "1", "1")).waitingOn).toEqual([0, 1]);
  });

  it("a dead seat does not end the continuing seat: continuing seat can still overtake", () => {
    const dead = seat("dead", "1000", "8");
    expect(resolveDuel(dead, seat(null, "900", "8")).status).toBe("pending");
    expect(resolveDuel(dead, seat("move-cap", "1200", "8")).outcome).toBe("seat1");
    expect(resolveDuel(dead, seat("move-cap", "800", "8")).outcome).toBe("seat0");
  });

  it("decides by exact score beyond 2^53", () => {
    const a = seat("move-cap", "9007199254740993", "50");
    const b = seat("move-cap", "9007199254740992", "50");
    expect(resolveDuel(a, b)).toMatchObject({ status: "finished", outcome: "seat0", decidedBy: "score" });
    expect(resolveDuel(b, a)).toMatchObject({ outcome: "seat1" });
    const huge0 = seat("dead", "1" + "0".repeat(40), "5");
    const huge1 = seat("dead", "9".repeat(40), "5");
    expect(resolveDuel(huge0, huge1).outcome).toBe("seat0");
  });

  it("falls back to max exponent, then draw", () => {
    expect(resolveDuel(seat("dead", "50", "10"), seat("dead", "50", "9"))).toMatchObject({ outcome: "seat0", decidedBy: "max-exponent" });
    expect(resolveDuel(seat("dead", "50", "9"), seat("dead", "50", "10"))).toMatchObject({ outcome: "seat1", decidedBy: "max-exponent" });
    expect(resolveDuel(seat("dead", "50", "10"), seat("move-cap", "50", "10"))).toMatchObject({ outcome: "draw", decidedBy: "draw" });
  });

  it("a forfeiting seat loses regardless of score; double forfeit is a draw", () => {
    expect(resolveDuel(seat("forfeit", "99999", "20"), seat("dead", "1", "1"))).toMatchObject({ outcome: "seat1", decidedBy: "forfeit" });
    expect(resolveDuel(seat("dead", "1", "1"), seat("forfeit", "99999", "20"))).toMatchObject({ outcome: "seat0", decidedBy: "forfeit" });
    expect(resolveDuel(seat("forfeit", "5", "2"), seat("forfeit", "9", "3"))).toMatchObject({ outcome: "draw", decidedBy: "double-forfeit" });
  });

  it("one forfeit while the other seat is still moving stays pending (rate only after both terminal)", () => {
    expect(resolveDuel(seat("forfeit", "5", "2"), seat(null, "1", "1")).status).toBe("pending");
  });

  it("maps outcomes to Elo scores", () => {
    expect(outcomeScoreForSeat0("seat0")).toBe(1);
    expect(outcomeScoreForSeat0("draw")).toBe(0.5);
    expect(outcomeScoreForSeat0("seat1")).toBe(0);
  });
});
