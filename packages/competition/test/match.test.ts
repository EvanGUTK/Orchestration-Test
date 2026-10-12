import { describe, expect, it } from "vitest";
import { canRate, createMatch, ratingEventsFor, reduceMatch, seatForAccount } from "../src/index.ts";
import type { MatchEvent, MatchState } from "../src/index.ts";

const h2h = () => createMatch({ id: "m1", kind: "human-vs-human", seasonId: "s2026-10", rulesetVersion: "duel-v1", hostAccountId: "alice" });
const run = (s: MatchState, ...events: MatchEvent[]) => events.reduce(reduceMatch, s);
const ended = (seat: 0 | 1, score: string, maxExponent = "7", reason: "dead" | "move-cap" = "move-cap"): MatchEvent => ({ type: "seat-ended", seat, reason, score, maxExponent, acceptedMoves: 500 });

describe("match state machine", () => {
  it("lobby then join activates; seat authority helpers", () => {
    const lobby = h2h();
    expect(lobby.status).toBe("lobby");
    expect(lobby.seats[1]).toBeNull();
    const active = run(lobby, { type: "join", accountId: "bob" });
    expect(active.status).toBe("active");
    expect(seatForAccount(active, "alice")).toBe(0);
    expect(seatForAccount(active, "bob")).toBe(1);
    expect(seatForAccount(active, "carol")).toBeNull();
  });

  it("rejects joining own match, a taken seat, bot matches; re-join by the occupant is idempotent", () => {
    const lobby = h2h();
    expect(() => reduceMatch(lobby, { type: "join", accountId: "alice" })).toThrow(/own match/);
    const active = reduceMatch(lobby, { type: "join", accountId: "bob" });
    expect(reduceMatch(active, { type: "join", accountId: "bob" })).toBe(active);
    expect(() => reduceMatch(active, { type: "join", accountId: "carol" })).toThrow(/no free seat/);
    const hvb = createMatch({ id: "m2", kind: "human-vs-bot", seasonId: "s", rulesetVersion: "duel-v1", hostAccountId: "alice", botLabels: ["expectimax"] });
    expect(() => reduceMatch(hvb, { type: "join", accountId: "bob" })).toThrow();
  });

  it("cannot end or forfeit seats before the match starts", () => {
    expect(() => reduceMatch(h2h(), { type: "forfeit", seat: 0 })).toThrow();
    expect(() => reduceMatch(h2h(), ended(0, "10"))).toThrow();
  });

  it("finalizes only after both seats are terminal; dead seat does not stop the other", () => {
    let s = run(h2h(), { type: "join", accountId: "bob" }, ended(0, "1000", "8", "dead"));
    expect(s.status).toBe("active");
    s = reduceMatch(s, { type: "progress", seat: 1, score: "900", maxExponent: "8", acceptedMoves: 400 });
    expect(s.status).toBe("active");
    s = reduceMatch(s, ended(1, "1100"));
    expect(s).toMatchObject({ status: "finished", outcome: "seat1", decidedBy: "score" });
  });

  it("absence never awards a win: forfeit alone stays active until the other seat is terminal", () => {
    let s = run(h2h(), { type: "join", accountId: "bob" });
    s = reduceMatch(s, { type: "forfeit", seat: 1 });
    expect(s.status).toBe("active");
    s = reduceMatch(s, ended(0, "5000"));
    expect(s).toMatchObject({ status: "finished", outcome: "seat0", decidedBy: "forfeit" });
  });

  it("double forfeit is a draw; forfeit is exactly-once and ignored after a natural end", () => {
    const base = run(h2h(), { type: "join", accountId: "bob" });
    const one = reduceMatch(base, { type: "forfeit", seat: 0 });
    expect(reduceMatch(one, { type: "forfeit", seat: 0 })).toBe(one);
    expect(reduceMatch(one, { type: "forfeit", seat: 1 })).toMatchObject({ status: "finished", outcome: "draw", decidedBy: "double-forfeit" });
    const done = reduceMatch(reduceMatch(base, ended(0, "10")), { type: "forfeit", seat: 0 });
    expect(done.seats[0].game.terminalReason).toBe("move-cap");
  });

  it("duplicate delivery is idempotent; conflicting results are rejected; progress cannot regress", () => {
    const base = run(h2h(), { type: "join", accountId: "bob" });
    const e = reduceMatch(base, ended(0, "123"));
    expect(reduceMatch(e, ended(0, "123"))).toBe(e);
    expect(() => reduceMatch(e, ended(0, "124"))).toThrow(/different result/);
    const p = reduceMatch(base, { type: "progress", seat: 1, score: "50", maxExponent: "5", acceptedMoves: 10 });
    expect(reduceMatch(p, { type: "progress", seat: 1, score: "50", maxExponent: "5", acceptedMoves: 10 })).toBe(p);
    expect(() => reduceMatch(p, { type: "progress", seat: 1, score: "49", maxExponent: "5", acceptedMoves: 11 })).toThrow(/regress/);
    expect(() => reduceMatch(p, { type: "progress", seat: 1, score: "51", maxExponent: "5", acceptedMoves: 9 })).toThrow(/regress/);
    expect(() => reduceMatch(p, { type: "progress", seat: 1, score: "01", maxExponent: "5", acceptedMoves: 12 })).toThrow();
  });

  it("exact scores above 2^53 decide the match", () => {
    const s = run(h2h(), { type: "join", accountId: "bob" }, ended(0, "9007199254740993"), ended(1, "9007199254740992"));
    expect(s.outcome).toBe("seat0");
  });

  it("rates exactly once, only human-vs-human", () => {
    const fin = run(h2h(), { type: "join", accountId: "bob" }, ended(0, "100"), ended(1, "90"));
    expect(canRate(fin)).toBe(true);
    const events = ratingEventsFor(fin, { seat0: 1000, seat1: 1000 })!;
    expect(events.map((e) => e.delta)).toEqual([12, -12]);
    const rated = reduceMatch(fin, { type: "rated" });
    expect(canRate(rated)).toBe(false);
    expect(ratingEventsFor(rated, { seat0: 1012, seat1: 988 })).toBeNull();
    expect(reduceMatch(rated, { type: "rated" })).toBe(rated);
    expect(() => reduceMatch(h2h(), { type: "rated" })).toThrow();
  });

  it("bots never produce rating events", () => {
    const hvb = createMatch({ id: "m2", kind: "human-vs-bot", seasonId: "s", rulesetVersion: "duel-v1", hostAccountId: "alice", botLabels: ["bots-1.0.0:expectimax"] });
    expect(hvb.status).toBe("active");
    const fin = run(hvb, ended(0, "100"), ended(1, "200"));
    expect(fin).toMatchObject({ status: "finished", outcome: "seat1", ratable: false });
    expect(canRate(fin)).toBe(false);
    expect(ratingEventsFor(fin, { seat0: 1000, seat1: 1000 })).toBeNull();
    const bvb = createMatch({ id: "m3", kind: "bot-vs-bot", seasonId: "s", rulesetVersion: "duel-v1", botLabels: ["a", "b"] });
    expect(ratingEventsFor(run(bvb, ended(0, "1"), ended(1, "1")), { seat0: 1000, seat1: 1000 })).toBeNull();
    expect(() => createMatch({ id: "x", kind: "bot-vs-bot", seasonId: "s", rulesetVersion: "r", botLabels: ["a"] })).toThrow();
  });

  it("does not mutate previous states", () => {
    const base = run(h2h(), { type: "join", accountId: "bob" });
    const snapshot = structuredClone(base);
    reduceMatch(base, ended(0, "5"));
    expect(base).toEqual(snapshot);
  });

  it("attach-game is idempotent and cannot be reassigned", () => {
    const base = run(h2h(), { type: "join", accountId: "bob" });
    const a = reduceMatch(base, { type: "attach-game", seat: 0, gameId: "g1" });
    expect(reduceMatch(a, { type: "attach-game", seat: 0, gameId: "g1" })).toBe(a);
    expect(() => reduceMatch(a, { type: "attach-game", seat: 0, gameId: "g2" })).toThrow();
  });
});
