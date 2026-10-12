import type { MatchKind, RatingEvent, SeatId, SeatTerminalReason } from "@g2048/contracts";
import { describe, expect, it } from "vitest";
import { CompetitionError } from "./errors.js";
import type { CompetitionErrorCode } from "./errors.js";
import { createMatch, pendingOutcome, reduceMatch } from "./match.js";
import type { MatchCommand, MatchState, Participant } from "./match.js";

const alice: Participant = { kind: "human", accountId: "acc-alice" };
const bob: Participant = { kind: "human", accountId: "acc-bob" };
const greedy: Participant = { kind: "bot", strategy: "greedy-v1", botVersion: "1.0.0" };
const expectimax: Participant = { kind: "bot", strategy: "expectimax-v1", botVersion: "1.0.0" };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

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

function lobby(kind: MatchKind = "human-human", creator: Participant = alice): MatchState {
  return deepFreeze(createMatch({ id: "m1", kind, season: "s1", creator }).state);
}

function active(kind: MatchKind = "human-human", a: Participant = alice, b: Participant = bob): MatchState {
  return deepFreeze(reduceMatch(lobby(kind, a), { type: "join", participant: b }).state);
}

function terminal(
  seat: SeatId,
  reason: SeatTerminalReason,
  score: string,
  maxExponent: string | null,
  acceptedMoves = reason === "move-cap" ? 500 : 10,
): MatchCommand {
  return { type: "seat-terminal", seat, reason, score, maxExponent, acceptedMoves };
}

function apply(state: MatchState, ...commands: MatchCommand[]): MatchState {
  return commands.reduce((s, c) => deepFreeze(reduceMatch(s, c).state), state);
}

describe("createMatch", () => {
  it("opens a lobby with the creator in seat a and duel-v1 defaults", () => {
    const { state, events } = createMatch({ id: "m1", kind: "human-human", season: "s1", creator: alice });
    expect(state.status).toBe("lobby");
    expect(state.rulesetVersion).toBe("duel-v1");
    expect(state.moveCap).toBe(500);
    expect(state.seats.a.participant).toEqual(alice);
    expect(state.seats.b.participant).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["match.created", "seat.joined"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(state.sequence).toBe(2);
  });

  it("validates kind/creator composition and inputs", () => {
    expectCode(
      () => createMatch({ id: "m", kind: "human-human", season: "s", creator: greedy }),
      "PARTICIPANT_KIND_MISMATCH",
    );
    expectCode(
      () => createMatch({ id: "m", kind: "bot-bot", season: "s", creator: alice }),
      "PARTICIPANT_KIND_MISMATCH",
    );
    expectCode(
      () => createMatch({ id: "", kind: "human-human", season: "s", creator: alice }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () => createMatch({ id: "m", kind: "human-human", season: "s", creator: alice, moveCap: 0 }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () => createMatch({ id: "m", kind: "ffa" as MatchKind, season: "s", creator: alice }),
      "VALIDATION_ERROR",
    );
    expectCode(
      () =>
        createMatch({
          id: "m",
          kind: "bot-bot",
          season: "s",
          creator: { kind: "bot", strategy: "llm-v1", botVersion: "1" } as unknown as Participant,
        }),
      "VALIDATION_ERROR",
    );
  });
});

describe("lobby -> active", () => {
  it("second distinct account joins seat b and the match starts", () => {
    const { state, events } = reduceMatch(lobby(), { type: "join", participant: bob });
    expect(state.status).toBe("active");
    expect(state.seats.b.participant).toEqual(bob);
    expect(events.map((e) => [e.type, e.sequence])).toEqual([
      ["seat.joined", 3],
      ["match.started", 4],
    ]);
  });

  it("the same account cannot take both seats", () => {
    expectCode(() => reduceMatch(lobby(), { type: "join", participant: { ...alice } }), "SAME_ACCOUNT");
  });

  it("an occupied seat cannot be taken", () => {
    expectCode(() => reduceMatch(lobby(), { type: "join", participant: bob, seat: "a" }), "SEAT_OCCUPIED");
  });

  it("participant kinds must match the match kind", () => {
    expectCode(
      () => reduceMatch(lobby(), { type: "join", participant: greedy }),
      "PARTICIPANT_KIND_MISMATCH",
    );
    expectCode(
      () => reduceMatch(lobby("human-bot"), { type: "join", participant: bob }),
      "PARTICIPANT_KIND_MISMATCH",
    );
    expectCode(
      () => reduceMatch(lobby("bot-bot", greedy), { type: "join", participant: alice }),
      "PARTICIPANT_KIND_MISMATCH",
    );
    expect(reduceMatch(lobby("human-bot"), { type: "join", participant: greedy }).state.status).toBe(
      "active",
    );
    expect(reduceMatch(lobby("human-bot", greedy), { type: "join", participant: alice }).state.status).toBe(
      "active",
    );
    expect(
      reduceMatch(lobby("bot-bot", greedy), { type: "join", participant: expectimax }).state.status,
    ).toBe("active");
    // Mirror bot-bot matches (same strategy in both seats) are allowed.
    expect(reduceMatch(lobby("bot-bot", greedy), { type: "join", participant: greedy }).state.status).toBe(
      "active",
    );
  });

  it("cannot join an active, finished, or abandoned match", () => {
    expectCode(() => reduceMatch(active(), { type: "join", participant: bob }), "INVALID_TRANSITION");
    const abandoned = apply(lobby(), { type: "abandon-lobby" });
    expect(abandoned.status).toBe("abandoned-lobby");
    expectCode(() => reduceMatch(abandoned, { type: "join", participant: bob }), "INVALID_TRANSITION");
    expectCode(() => reduceMatch(abandoned, { type: "abandon-lobby" }), "INVALID_TRANSITION");
    expectCode(() => reduceMatch(active(), { type: "abandon-lobby" }), "INVALID_TRANSITION");
  });

  it("seat updates and finish are rejected in the lobby", () => {
    expectCode(() => reduceMatch(lobby(), terminal("a", "forfeit", "0", null, 0)), "INVALID_TRANSITION");
    expectCode(() => reduceMatch(lobby(), { type: "finish" }), "INVALID_TRANSITION");
  });
});

describe("seat terminal events", () => {
  it("one dead board does not end the other seat; it keeps playing to the cap", () => {
    let s = apply(active(), terminal("a", "dead-board", "1200", "7", 140));
    expect(s.status).toBe("active");
    expect(pendingOutcome(s)).toBeNull();
    s = apply(s, { type: "seat-progress", seat: "b", score: "900", maxExponent: "7", acceptedMoves: 300 });
    expect(s.seats.b.acceptedMoves).toBe(300);
    const { state, events } = reduceMatch(s, terminal("b", "move-cap", "5000", "9"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "seat.ended", seat: "b", readyToFinish: true });
    expect(state.status).toBe("active");
    expect(pendingOutcome(state)).toBe("seat-b");
  });

  it("each seat becomes terminal exactly once", () => {
    const s = apply(active(), terminal("a", "dead-board", "100", "5"));
    expectCode(() => reduceMatch(s, terminal("a", "forfeit", "100", "5")), "SEAT_ALREADY_TERMINAL");
    expectCode(
      () =>
        reduceMatch(s, {
          type: "seat-progress",
          seat: "a",
          score: "100",
          maxExponent: "5",
          acceptedMoves: 10,
        }),
      "SEAT_ALREADY_TERMINAL",
    );
  });

  it("validates move-cap, monotonic progress, and exact values", () => {
    const s = active();
    expectCode(() => reduceMatch(s, terminal("a", "move-cap", "100", "5", 499)), "VALIDATION_ERROR");
    expectCode(() => reduceMatch(s, terminal("a", "dead-board", "100", "5", 501)), "VALIDATION_ERROR");
    expectCode(() => reduceMatch(s, terminal("a", "dead-board", "1e3", "5")), "VALIDATION_ERROR");
    expectCode(() => reduceMatch(s, terminal("a", "dead-board", "100", "0")), "VALIDATION_ERROR");
    expectCode(() => reduceMatch(s, terminal("c" as SeatId, "dead-board", "100", "5")), "VALIDATION_ERROR");
    expectCode(
      () => reduceMatch(s, terminal("a", "timeout" as SeatTerminalReason, "100", "5")),
      "VALIDATION_ERROR",
    );
    expectCode(
      () =>
        reduceMatch(s, {
          type: "seat-progress",
          seat: "a",
          score: "1",
          maxExponent: "1",
          acceptedMoves: 500,
        }),
      "VALIDATION_ERROR",
    );
    const progressed = apply(s, {
      type: "seat-progress",
      seat: "a",
      score: "64",
      maxExponent: "5",
      acceptedMoves: 20,
    });
    expectCode(() => reduceMatch(progressed, terminal("a", "dead-board", "60", "5", 25)), "VALIDATION_ERROR");
    expectCode(() => reduceMatch(progressed, terminal("a", "dead-board", "64", "5", 19)), "VALIDATION_ERROR");
    expectCode(() => reduceMatch(progressed, terminal("a", "dead-board", "64", "4", 25)), "VALIDATION_ERROR");
  });

  it("an absent participant never times out into a win: only explicit forfeit ends the seat", () => {
    const s = apply(active(), terminal("a", "move-cap", "9000", "10"));
    // No command can end seat b except its own terminal event; finishing is not possible.
    expectCode(() => reduceMatch(s, { type: "finish", ratings: { a: 1000, b: 1000 } }), "MATCH_NOT_READY");
    expectCode(() => reduceMatch(s, { type: "timeout" } as unknown as MatchCommand), "VALIDATION_ERROR");
    expect(s.status).toBe("active");
    const forfeited = apply(s, terminal("b", "forfeit", "0", null, 0));
    expect(pendingOutcome(forfeited)).toBe("seat-a");
  });
});

describe("finish and rating", () => {
  const bothDone = (): MatchState =>
    apply(
      active(),
      terminal("a", "move-cap", "20000", "11"),
      terminal("b", "dead-board", "18000", "11", 420),
    );

  it("finishes exactly once with outcome and conserved human Elo", () => {
    const { state, events } = reduceMatch(bothDone(), { type: "finish", ratings: { a: 1000, b: 1000 } });
    expect(state.status).toBe("finished");
    expect(state.outcome).toBe("seat-a");
    expect(events.map((e) => e.type)).toEqual(["match.finished", "rating.updated", "rating.updated"]);
    expect(events.map((e) => e.sequence)).toEqual([7, 8, 9]);
    expect(state.sequence).toBe(9);
    const [ra, rb] = state.ratingEvents as [RatingEvent, RatingEvent];
    expect(ra).toEqual({
      matchId: "m1",
      accountId: "acc-alice",
      season: "s1",
      rulesetVersion: "duel-v1",
      before: 1000,
      after: 1012,
      delta: 12,
      outcome: 1,
      algorithm: "elo-v1",
      idempotencyKey: "m1:acc-alice",
    });
    expect(rb).toMatchObject({ accountId: "acc-bob", before: 1000, after: 988, delta: -12, outcome: 0 });
    expect(ra.delta + rb.delta).toBe(0);
    expectCode(
      () => reduceMatch(state, { type: "finish", ratings: { a: 1012, b: 988 } }),
      "MATCH_ALREADY_FINISHED",
    );
    expectCode(() => reduceMatch(state, terminal("a", "forfeit", "1", "1")), "INVALID_TRANSITION");
    expectCode(() => reduceMatch(state, { type: "join", participant: bob }), "INVALID_TRANSITION");
  });

  it("concurrent finishes from the same base state yield identical rating events with one key per account", () => {
    const base = bothDone();
    const first = reduceMatch(base, { type: "finish", ratings: { a: 1100, b: 1050 } });
    const second = reduceMatch(base, { type: "finish", ratings: { a: 1100, b: 1050 } });
    expect(second.state.ratingEvents).toEqual(first.state.ratingEvents);
    const keys = [...first.state.ratingEvents, ...second.state.ratingEvents].map((e) => e.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set(["m1:acc-alice", "m1:acc-bob"]));
    // Serialized (as the backend transaction does), the loser of the race is rejected.
    expectCode(
      () => reduceMatch(first.state, { type: "finish", ratings: { a: 1100, b: 1050 } }),
      "MATCH_ALREADY_FINISHED",
    );
  });

  it("draws and double forfeits rate 0.5/0.5", () => {
    const draw = apply(active(), terminal("a", "forfeit", "500", "8"), terminal("b", "forfeit", "100", "5"));
    const { state } = reduceMatch(draw, { type: "finish", ratings: { a: 1000, b: 1000 } });
    expect(state.outcome).toBe("draw");
    expect(state.ratingEvents.map((e) => [e.outcome, e.delta])).toEqual([
      [0.5, 0],
      [0.5, 0],
    ]);
  });

  it("human-human finish requires ratings; ratings must be integers", () => {
    expectCode(() => reduceMatch(bothDone(), { type: "finish" }), "RATINGS_REQUIRED");
    expectCode(
      () => reduceMatch(bothDone(), { type: "finish", ratings: { a: 1000.5, b: 1000 } }),
      "VALIDATION_ERROR",
    );
  });

  it("human-bot and bot-bot finish without touching human Elo", () => {
    for (const [kind, a, b] of [
      ["human-bot", alice, greedy],
      ["bot-bot", greedy, expectimax],
    ] as const) {
      const done = apply(
        active(kind, a, b),
        terminal("a", "move-cap", "100", "5"),
        terminal("b", "forfeit", "900", "8"),
      );
      expectCode(
        () => reduceMatch(done, { type: "finish", ratings: { a: 1000, b: 1000 } }),
        "RATINGS_FORBIDDEN",
      );
      const { state, events } = reduceMatch(done, { type: "finish" });
      expect(state.status).toBe("finished");
      expect(state.outcome).toBe("seat-a");
      expect(state.ratingEvents).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(["match.finished"]);
    }
  });

  it("never mutates its input", () => {
    const base = bothDone(); // deep-frozen; a mutation would throw in strict mode
    const snapshot = JSON.stringify(base);
    reduceMatch(base, { type: "finish", ratings: { a: 1000, b: 1000 } });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("decides exact high scores far above 2^53", () => {
    const hi = (2n ** 80n + 1n).toString();
    const lo = (2n ** 80n).toString();
    const s = apply(active(), terminal("a", "move-cap", lo, "70"), terminal("b", "move-cap", hi, "70"));
    expect(reduceMatch(s, { type: "finish", ratings: { a: 1000, b: 1000 } }).state.outcome).toBe("seat-b");
  });
});
