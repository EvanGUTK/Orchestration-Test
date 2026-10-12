import type { RatingEvent } from "@g2048/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CompetitionError } from "./errors.js";
import type { CompetitionErrorCode } from "./errors.js";
import { createMatch, reduceMatch } from "./match.js";
import type { MatchCommand, MatchState } from "./match.js";
import {
  applyRatingEvent,
  currentRating,
  getRatingRecord,
  hasAppliedRatingEvent,
  initialSeasons,
  ratingKey,
  startSeason,
} from "./season.js";
import type { SeasonsState } from "./season.js";

function expectCode(fn: () => unknown, code: CompetitionErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CompetitionError);
    expect((error as CompetitionError).code).toBe(code);
    return;
  }
  throw new Error(`expected CompetitionError ${code}`);
}

function season(id = "s1"): SeasonsState {
  return startSeason(initialSeasons(), id).state;
}

/** Plays a full human-human match through the reducer, rating from the ladder. */
function playRated(
  ladder: SeasonsState,
  matchId: string,
  a: string,
  b: string,
  scoreA: string,
  scoreB: string,
): MatchState {
  const seasonId = ladder.activeSeason as string;
  let m = createMatch({
    id: matchId,
    kind: "human-human",
    season: seasonId,
    creator: { kind: "human", accountId: a },
  }).state;
  const commands: MatchCommand[] = [
    { type: "join", participant: { kind: "human", accountId: b } },
    {
      type: "seat-terminal",
      seat: "a",
      reason: "move-cap",
      score: scoreA,
      maxExponent: "9",
      acceptedMoves: 500,
    },
    {
      type: "seat-terminal",
      seat: "b",
      reason: "move-cap",
      score: scoreB,
      maxExponent: "9",
      acceptedMoves: 500,
    },
    {
      type: "finish",
      ratings: {
        a: currentRating(ladder, a, m.rulesetVersion),
        b: currentRating(ladder, b, m.rulesetVersion),
      },
    },
  ];
  for (const c of commands) m = reduceMatch(m, c).state;
  return m;
}

function applyAll(state: SeasonsState, events: readonly RatingEvent[]): SeasonsState {
  return events.reduce((s, e) => applyRatingEvent(s, e).state, state);
}

describe("season policy", () => {
  it("initializes ratings at 1000 per account + season + ruleset", () => {
    const s = season();
    expect(s.activeSeason).toBe("s1");
    expect(currentRating(s, "acc-alice", "duel-v1")).toBe(1000);
    expect(getRatingRecord(s, "acc-alice", "duel-v1")).toEqual({
      accountId: "acc-alice",
      season: "s1",
      rulesetVersion: "duel-v1",
      rating: 1000,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
    });
    expect(ratingKey("a", "b", "c")).not.toBe(ratingKey("a:b", "", "c"));
  });

  it("a new season archives the prior ladder and resets ratings to 1000", () => {
    let s = season("s1");
    const m = playRated(s, "m1", "acc-alice", "acc-bob", "300", "100");
    s = applyAll(s, m.ratingEvents);
    expect(currentRating(s, "acc-alice", "duel-v1")).toBe(1012);
    const next = startSeason(s, "s2");
    expect(next.events).toEqual([
      { type: "season.archived", season: "s1" },
      { type: "season.started", season: "s2", initialRating: 1000 },
    ]);
    expect(next.state.activeSeason).toBe("s2");
    expect(next.state.order).toEqual(["s1", "s2"]);
    expect(next.state.ladders.s1?.status).toBe("archived");
    expect(currentRating(next.state, "acc-alice", "duel-v1")).toBe(1000);
    expect(currentRating(next.state, "acc-alice", "duel-v1", "s1")).toBe(1012); // archive still readable
    expectCode(() => startSeason(next.state, "s1"), "SEASON_EXISTS");
  });

  it("archived ladders are frozen: new rating events are rejected", () => {
    const s1 = season("s1");
    const m = playRated(s1, "m1", "acc-alice", "acc-bob", "300", "100");
    const archived = startSeason(s1, "s2").state;
    expectCode(() => applyRatingEvent(archived, m.ratingEvents[0] as RatingEvent), "SEASON_NOT_ACTIVE");
  });

  it("ratings are per ruleset within a season", () => {
    let s = season();
    const m = playRated(s, "m1", "acc-alice", "acc-bob", "300", "100");
    s = applyAll(s, m.ratingEvents);
    expect(currentRating(s, "acc-alice", "duel-v1")).toBe(1012);
    expect(currentRating(s, "acc-alice", "duel-v2")).toBe(1000);
  });

  it("requires an existing season", () => {
    expectCode(() => currentRating(initialSeasons(), "acc-alice", "duel-v1"), "SEASON_NOT_ACTIVE");
    expectCode(() => currentRating(season(), "acc-alice", "duel-v1", "nope"), "SEASON_NOT_ACTIVE");
  });
});

describe("rating ledger idempotency", () => {
  it("duplicate finish events apply exactly once per account per match", () => {
    let s = season();
    const m = playRated(s, "m1", "acc-alice", "acc-bob", "100", "300");
    s = applyAll(s, m.ratingEvents);
    const once = s;
    for (const e of m.ratingEvents) {
      const again = applyRatingEvent(s, e);
      expect(again.applied).toBe(false);
      expect(again.state).toBe(s);
    }
    expect(currentRating(once, "acc-alice", "duel-v1")).toBe(988);
    expect(currentRating(once, "acc-bob", "duel-v1")).toBe(1012);
    expect(getRatingRecord(once, "acc-bob", "duel-v1")).toMatchObject({
      played: 1,
      won: 1,
      lost: 0,
      drawn: 0,
    });
    expect(hasAppliedRatingEvent(once, "s1", "m1:acc-alice")).toBe(true);
  });

  it("concurrent finishes computed from the same base produce a single rating change per account", () => {
    const s = season();
    const base = playRated(s, "m1", "acc-alice", "acc-bob", "300", "300"); // draw
    // Simulate a racing second finish computed from the pre-finish state of the same match.
    const raced = playRated(s, "m1", "acc-alice", "acc-bob", "300", "300");
    const after = applyAll(applyAll(s, base.ratingEvents), raced.ratingEvents);
    const keys = Object.keys(after.ladders.s1?.appliedEventKeys ?? {});
    expect(keys.sort()).toEqual(["m1:acc-alice", "m1:acc-bob"]);
    expect(getRatingRecord(after, "acc-alice", "duel-v1")).toMatchObject({
      rating: 1000,
      played: 1,
      drawn: 1,
    });
  });

  it("rejects stale or malformed events", () => {
    const s = season();
    const m = playRated(s, "m1", "acc-alice", "acc-bob", "300", "100");
    const e = m.ratingEvents[0] as RatingEvent;
    expectCode(() => applyRatingEvent(s, { ...e, before: 1100, after: 1112 }), "RATING_STALE");
    expectCode(() => applyRatingEvent(s, { ...e, after: e.after + 1 }), "VALIDATION_ERROR");
    expectCode(() => applyRatingEvent(s, { ...e, algorithm: "glicko" }), "VALIDATION_ERROR");
    expectCode(() => applyRatingEvent(s, { ...e, idempotencyKey: "m1" }), "VALIDATION_ERROR");
    expectCode(() => applyRatingEvent(s, { ...e, season: "s9" }), "SEASON_NOT_ACTIVE");
  });

  it("bot matches never touch human Elo", () => {
    let s = season();
    for (const kind of ["human-bot", "bot-bot"] as const) {
      const creator =
        kind === "human-bot"
          ? ({ kind: "human", accountId: "acc-alice" } as const)
          : ({ kind: "bot", strategy: "random-v1", botVersion: "1" } as const);
      let m = createMatch({ id: `m-${kind}`, kind, season: "s1", creator }).state;
      for (const c of [
        { type: "join", participant: { kind: "bot", strategy: "expectimax-v1", botVersion: "1" } },
        {
          type: "seat-terminal",
          seat: "a",
          reason: "move-cap",
          score: "9000",
          maxExponent: "10",
          acceptedMoves: 500,
        },
        {
          type: "seat-terminal",
          seat: "b",
          reason: "dead-board",
          score: "10",
          maxExponent: "3",
          acceptedMoves: 30,
        },
        { type: "finish" },
      ] as MatchCommand[]) {
        m = reduceMatch(m, c).state;
      }
      expect(m.ratingEvents).toEqual([]);
      s = applyAll(s, m.ratingEvents);
    }
    expect(getRatingRecord(s, "acc-alice", "duel-v1")).toMatchObject({ rating: 1000, played: 0 });
  });

  it("conserves the season rating pool across many rated matches", () => {
    const players = ["p0", "p1", "p2", "p3", "p4"];
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 4 }), fc.nat({ max: 4 }), fc.nat({ max: 3 }), fc.nat({ max: 3 })), {
          maxLength: 40,
        }),
        (games) => {
          let s = season();
          games.forEach(([i, j, sa, sb], n) => {
            if (i === j) return;
            const m = playRated(
              s,
              `m${n}`,
              players[i] as string,
              players[j] as string,
              String(sa),
              String(sb),
            );
            s = applyAll(s, m.ratingEvents);
            s = applyAll(s, m.ratingEvents); // duplicate delivery is a no-op
          });
          const total = players.reduce((sum, p) => sum + currentRating(s, p, "duel-v1"), 0);
          expect(total).toBe(5000);
        },
      ),
      { numRuns: 100 },
    );
  });
});
