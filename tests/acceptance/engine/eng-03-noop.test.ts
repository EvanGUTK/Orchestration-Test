// ENG-03 | No-op then changed move
// Pass evidence: no-op leaves score/moves/revision/PRNG unchanged; valid move spawns once.
import { describe, expect, it } from "vitest";
import { E } from "./engine-api.js";
import { CLASSIC, VECTORS, frozen, makeState, mass, rows, rulesForState, tileCount } from "./helpers.js";

describe("ENG-03 no-op then changed move", () => {
  const base = makeState(rows("1 2 . .", ". . . .", ". . . .", ". . . .").cells, {
    score: "12",
    acceptedMoves: 5,
    revision: 7,
  });

  it('a no-op returns changed:false, scoreDelta "0", no events, identical state values and checksum', () => {
    const input = frozen(base);
    const res = E.applyMove(input, "left", CLASSIC);
    expect(res.changed).toBe(false);
    expect(res.scoreDelta).toBe("0");
    expect(res.events).toEqual([]);
    expect(res.state).toEqual(base);
    expect(res.state.rng.words).toEqual(base.rng.words);
    expect(res.state.score).toBe("12");
    expect(res.state.acceptedMoves).toBe(5);
    expect(res.state.revision).toBe(7);
    expect(E.checksum(res.state)).toBe(E.checksum(input));
  });

  it("repeated no-ops never advance the PRNG", () => {
    let state = frozen(base);
    for (let i = 0; i < 25; i++)
      state = frozen(E.applyMove(state, i % 2 === 0 ? "left" : "up", CLASSIC).state);
    expect(state).toEqual(base);
  });

  it("the following changed move spawns exactly once and advances counters by one", () => {
    const noop = E.applyMove(frozen(base), "left", CLASSIC).state;
    const res = E.applyMove(frozen(noop), "right", CLASSIC);
    const slid = E.slide(frozen(base.board), "right");
    expect(res.changed).toBe(true);
    const spawns = res.events.filter((e) => e.type === "tile.spawned");
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0];
    if (spawn?.type !== "tile.spawned") throw new Error("unreachable");
    expect(slid.board.cells[spawn.at]).toBeNull();
    expect(["1", "2"]).toContain(spawn.exponent);
    expect(res.state.board.cells[spawn.at]).toBe(spawn.exponent);
    // only the spawned cell differs from the deterministic slide
    const diff = res.state.board.cells.flatMap((c, i) => (c !== slid.board.cells[i] ? [i] : []));
    expect(diff).toEqual([spawn.at]);
    expect(tileCount(res.state.board)).toBe(tileCount(base.board) + 1);
    expect(mass(res.state.board)).toBe(mass(base.board) + (1n << BigInt(spawn.exponent)));
    expect(res.state.acceptedMoves).toBe(6);
    expect(res.state.revision).toBe(8);
    expect(res.state.rng.words).not.toEqual(base.rng.words);
    expect(res.state.score).toBe("12");
  });

  it("golden move sequences: every no-op step keeps rng words, every changed step spawns once", () => {
    for (const seq of VECTORS.moveSequences) {
      expect(seq.noOpSteps.length).toBeGreaterThan(0);
      let state = frozen(seq.initial.state);
      const rules = rulesForState(state);
      for (const step of seq.steps) {
        const before = state;
        const res = E.applyMove(state, step.direction, rules);
        expect(res.changed, `seed ${seq.seed} step ${step.step}`).toBe(step.changed);
        expect(res.scoreDelta).toBe(step.scoreDelta);
        const spawns = res.events.filter((e) => e.type === "tile.spawned");
        if (step.changed) {
          expect(spawns).toEqual([
            { type: "tile.spawned", at: step.spawn?.index, exponent: step.spawn?.exponent },
          ]);
          expect(res.state.acceptedMoves).toBe(before.acceptedMoves + 1);
        } else {
          expect(spawns).toEqual([]);
          expect(res.events).toEqual([]);
          expect(res.state).toEqual(before);
        }
        expect(res.state.rng.words).toEqual(step.rngWords);
        state = frozen(res.state);
      }
    }
  });
});
