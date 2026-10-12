// ENG-06 | Reach 2048 then continue
// Pass evidence: one celebration; game remains active if legal moves exist.
import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@g2048/contracts";
import { E } from "./engine-api.js";
import { CLASSIC, frozen, makeState, rows, transition } from "./helpers.js";

const milestones = (events: readonly DomainEvent[]) => events.filter((e) => e.type === "milestone.reached");

describe("ENG-06 reach 2048 then continue", () => {
  it("first 2048 sets celebrated2048 once, emits one first2048 milestone, and stays active (golden)", () => {
    const t = transition("first-2048-celebrates");
    if (!t.before || !t.after || !t.direction) throw new Error("bad vector");
    const res = E.applyMove(frozen(t.before.state), t.direction, CLASSIC);
    expect(res.state).toEqual(t.after.state);
    expect(E.checksum(res.state)).toBe(t.after.checksum);
    expect(res.state.celebrated2048).toBe(true);
    expect(res.state.status).toBe("active");
    expect(milestones(res.events)).toEqual([{ type: "milestone.reached", exponent: "11", first2048: true }]);
    // milestone comes after the spawn
    const spawnAt = res.events.findIndex((e) => e.type === "tile.spawned");
    const milestoneAt = res.events.findIndex((e) => e.type === "milestone.reached");
    expect(spawnAt).toBeGreaterThanOrEqual(0);
    expect(milestoneAt).toBeGreaterThan(spawnAt);
  });

  it("already celebrated: 2048+2048 keeps celebrated2048 true and never re-celebrates (golden)", () => {
    const t = transition("already-celebrated-stays-true");
    if (!t.before || !t.after || !t.direction) throw new Error("bad vector");
    const res = E.applyMove(frozen(t.before.state), t.direction, CLASSIC);
    expect(res.state).toEqual(t.after.state);
    expect(res.state.celebrated2048).toBe(true);
    // max exponent rose 11 -> 12 (>= 11): a milestone, but not a first-2048 celebration
    expect(milestones(res.events)).toEqual([{ type: "milestone.reached", exponent: "12", first2048: false }]);
  });

  it("a second 2048 tile after celebrating emits no first2048 milestone", () => {
    const state = frozen(
      makeState(rows("11 . . .", "10 10 . .", ". . . .", ". . . .").cells, {
        celebrated2048: true,
        score: "30000",
      }),
    );
    const res = E.applyMove(state, "left", CLASSIC);
    expect(res.changed).toBe(true);
    expect(res.state.celebrated2048).toBe(true);
    expect(milestones(res.events)).toEqual([]);
    expect(res.state.status).toBe("active");
  });

  it("play continues after 2048: further moves are accepted while legal moves exist", () => {
    let state = frozen(makeState(rows("10 10 . .", ". . . .", ". . . .", ". . . .").cells));
    state = frozen(E.applyMove(state, "left", CLASSIC).state);
    expect(state.celebrated2048).toBe(true);
    let accepted = 0;
    for (const d of ["right", "down", "left", "up", "right", "down"] as const) {
      if (state.status !== "active") break;
      const res = E.applyMove(state, d, CLASSIC);
      if (res.changed) accepted++;
      state = frozen(res.state);
      expect(state.celebrated2048).toBe(true);
      expect(milestones(res.events).some((m) => m.type === "milestone.reached" && m.first2048)).toBe(false);
    }
    expect(accepted).toBeGreaterThan(0);
    expect(state.status).toBe("active");
  });
});
