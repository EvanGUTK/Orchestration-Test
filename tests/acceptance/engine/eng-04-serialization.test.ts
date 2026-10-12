// ENG-04 | Seeded games and serialization
// Pass evidence: same seed/moves give identical complete state after reload.
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, REPLAY_SCHEMA_VERSION } from "@g2048/contracts";
import type { Direction, GameState, ReplayFile } from "@g2048/contracts";
import { E } from "./engine-api.js";
import { CLASSIC, VECTORS, frozen, rulesForState } from "./helpers.js";

function play(state: GameState, moves: readonly Direction[]): GameState {
  const rules = rulesForState(state);
  let s = frozen(state);
  for (const d of moves) s = frozen(E.applyMove(s, d, rules).state);
  return s;
}

function replayFile(seq: (typeof VECTORS.moveSequences)[number]): ReplayFile {
  const changed = seq.steps.filter((s) => s.changed);
  return {
    replaySchemaVersion: REPLAY_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: seq.initial.state.rulesetVersion,
    seed: seq.seed,
    initialState: seq.initial.state,
    initialChecksum: seq.initial.checksum,
    moves: changed.map((s) => ({ revision: s.revision, direction: s.direction, checksum: s.checksum })),
    finalChecksum: seq.final.checksum,
    meta: { mode: "classic", displayName: null, createdAt: "2026-10-12T00:00:00.000Z", source: "local" },
  };
}

describe("ENG-04 seeded games and serialization", () => {
  it("the same seed gives an identical complete state; different seeds diverge", () => {
    const a = E.newGame(frozen(CLASSIC), "same-seed");
    const b = E.newGame(frozen(CLASSIC), "same-seed");
    expect(a).toEqual(b);
    expect(E.checksum(a)).toBe(E.checksum(b));
    const others = ["s1", "s2", "s3", "s4"].map((s) => E.checksum(E.newGame(CLASSIC, s)));
    expect(new Set([E.checksum(a), ...others]).size).toBe(5);
  });

  it("serialize() is the canonical JSON and round-trips through deserialize()", () => {
    for (const g of VECTORS.newGame) {
      const text = E.serialize(frozen(g.state));
      expect(text).toBe(g.canonicalJson);
      expect(E.canonicalJson(frozen(g.state))).toBe(g.canonicalJson);
      const back = E.deserialize(text);
      expect(back).toEqual(g.state);
      expect(E.checksum(back)).toBe(g.checksum);
    }
  });

  for (const seq of VECTORS.moveSequences) {
    it(`seed ${seq.seed}: same seed + same moves reproduce the golden final state`, () => {
      const initial = E.newGame(CLASSIC, seq.seed);
      expect(initial).toEqual(seq.initial.state);
      const final = play(initial, seq.directions);
      expect(final).toEqual(seq.final.state);
      expect(E.canonicalJson(final)).toBe(seq.final.canonicalJson);
    });

    it(`seed ${seq.seed}: save/reload at every step continues identically`, () => {
      const rules = rulesForState(seq.initial.state);
      let state = frozen(seq.initial.state);
      for (const step of seq.steps) {
        const reloaded = frozen(E.deserialize(E.serialize(state)));
        expect(reloaded).toEqual(state);
        state = frozen(E.applyMove(reloaded, step.direction, rules).state);
        expect(E.checksum(state)).toBe(step.checksum);
      }
      expect(state).toEqual(seq.final.state);
    });

    it(`seed ${seq.seed}: replay() reproduces per-move checksums and final state`, () => {
      const changed = seq.steps.filter((s) => s.changed);
      const res = E.replay(frozen(seq.initial.state), frozen(changed.map((s) => s.direction)), CLASSIC);
      expect(res.final).toEqual(seq.final.state);
      expect(res.checksums).toEqual(changed.map((s) => s.checksum));
    });

    it(`seed ${seq.seed}: verifyReplay() accepts the genuine file and rejects a tampered move checksum`, () => {
      const file = replayFile(seq);
      const ok = E.verifyReplay(frozen(file), CLASSIC);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.final).toEqual(seq.final.state);

      const tampered = structuredClone(file);
      const target = tampered.moves[3];
      if (!target) throw new Error("vector too short");
      target.checksum = "0".repeat(64);
      const bad = E.verifyReplay(frozen(tampered), CLASSIC);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.atMove).not.toBeNull();

      const forgedScore = structuredClone(file);
      forgedScore.initialState = { ...forgedScore.initialState, score: "999999" };
      expect(E.verifyReplay(frozen(forgedScore), CLASSIC).ok).toBe(false);
    });
  }

  it("verifyReplay() rejects an unsupported replay schema version with REPLAY_VERSION_UNSUPPORTED", () => {
    const seq = VECTORS.moveSequences[0];
    if (!seq) throw new Error("no vectors");
    const file = { ...replayFile(seq), replaySchemaVersion: 2 } as unknown as ReplayFile;
    const res = E.verifyReplay(frozen(file), CLASSIC);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("REPLAY_VERSION_UNSUPPORTED");
  });
});
