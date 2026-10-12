import { describe, expect, it } from "vitest";
import { acceptsNewResults, compareLadder, initialRating, isInstantInSeason, rankLadder, rolloverSeason, seasonBounds, seasonIdForInstant } from "../src/index.ts";
import type { LadderRow } from "../src/index.ts";

const row = (accountId: string, rating: number, won = 0, played = 0): LadderRow => ({ accountId, rating, played, won, drawn: 0, lost: played - won });

describe("season policy", () => {
  it("derives ids and bounds from explicit instants (UTC)", () => {
    expect(seasonIdForInstant("2026-10-12T22:54:11Z")).toBe("s2026-10");
    expect(seasonIdForInstant("2026-12-31T23:59:59.999Z")).toBe("s2026-12");
    expect(seasonIdForInstant("2027-01-01T00:00:00Z")).toBe("s2027-01");
    expect(seasonBounds("s2026-12")).toEqual({ startsAt: "2026-12-01T00:00:00.000Z", endsAt: "2027-01-01T00:00:00.000Z" });
    expect(() => seasonIdForInstant("nope")).toThrow();
    expect(() => seasonBounds("2026-10")).toThrow();
    expect(() => seasonBounds("s2026-13")).toThrow();
  });

  it("season membership is [start, end)", () => {
    const b = seasonBounds("s2026-10");
    expect(isInstantInSeason(b, "2026-10-01T00:00:00Z")).toBe(true);
    expect(isInstantInSeason(b, "2026-11-01T00:00:00Z")).toBe(false);
    expect(isInstantInSeason(b, "2026-09-30T23:59:59Z")).toBe(false);
    expect(isInstantInSeason({ startsAt: b.startsAt, endsAt: null }, "2099-01-01T00:00:00Z")).toBe(true);
    expect(isInstantInSeason(b, "garbage")).toBe(false);
  });

  it("only active seasons take new results", () => {
    expect(acceptsNewResults({ status: "active" })).toBe(true);
    expect(acceptsNewResults({ status: "archived" })).toBe(false);
  });

  it("orders the ladder: rating desc, wins desc, played asc, account id", () => {
    const rows = [row("d", 1000, 1, 2), row("a", 1000, 1, 1), row("c", 1100, 0, 5), row("b", 1000, 1, 1), row("e", 1000, 2, 4)];
    expect(rankLadder(rows).map((r) => [r.accountId, r.rank])).toEqual([["c", 1], ["e", 2], ["a", 3], ["b", 4], ["d", 5]]);
    expect(compareLadder(rows[0]!, rows[0]!)).toBe(0);
  });

  it("rolls over by archiving the old ladder and resetting ratings to 1000", () => {
    const { archived, nextRatings } = rolloverSeason([row("a", 1200), row("b", 900)]);
    expect(archived.map((r) => r.accountId)).toEqual(["a", "b"]);
    expect(nextRatings).toEqual([{ accountId: "a", rating: 1000 }, { accountId: "b", rating: 1000 }]);
    expect(initialRating()).toBe(1000);
  });
});
