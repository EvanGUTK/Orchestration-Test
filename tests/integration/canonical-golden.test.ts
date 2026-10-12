/**
 * Literal canonical-state goldens (packages/contracts/golden/canonical-v1.json): the oracle (independent) and
 * @2048/engine must both reproduce the exact canonical JSON string and SHA-256 for every case, and the engine
 * must round-trip it (deserialize -> serialize) without a byte of drift.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GameState } from "@2048/contracts";
import * as engine from "@2048/engine";
import { canonical, checksum, ENGINE_VERSION, type Cell, type OState } from "./oracle/game.ts";

type Case = {
  id: string;
  rulesetVersion: string;
  size: number;
  cells: Cell[];
  score: string;
  acceptedMoves: number;
  revision: number;
  rngWords: [number, number, number, number];
  status: OState["status"];
  celebrated2048: boolean;
  canonicalJson: string;
  checksum: string;
};
const file = JSON.parse(readFileSync(new URL("../../packages/contracts/golden/canonical-v1.json", import.meta.url), "utf8")) as {
  schemaVersion: number;
  checksumVersion: number;
  engineVersion: string;
  cases: Case[];
};
const toState = (c: Case): OState => ({
  schemaVersion: 1,
  engineVersion: file.engineVersion,
  rulesetVersion: c.rulesetVersion,
  board: { size: c.size, cells: c.cells },
  score: c.score,
  acceptedMoves: c.acceptedMoves,
  revision: c.revision,
  rng: { algorithm: "xoshiro128ss-v1", words: c.rngWords },
  status: c.status,
  celebrated2048: c.celebrated2048,
});

describe("canonical-v1.json", () => {
  it("header and coverage: fresh, >2^53 score, big exponents, completed, celebrated", () => {
    expect(file.schemaVersion).toBe(1);
    expect(file.checksumVersion).toBe(1);
    expect(file.engineVersion).toBe(ENGINE_VERSION);
    expect(file.cases.length).toBeGreaterThanOrEqual(5);
    expect(file.cases.some((c) => c.score.length > 16)).toBe(true);
    expect(file.cases.some((c) => c.cells.some((x) => x !== null && BigInt(x) >= 255n))).toBe(true);
    expect(file.cases.some((c) => c.status === "completed")).toBe(true);
    expect(file.cases.some((c) => c.celebrated2048)).toBe(true);
  });

  for (const c of file.cases) {
    describe(c.id, () => {
      const state = toState(c);
      it("the literal is itself well formed: compact, parseable, fixed key order, checksum is sha256(utf8)", () => {
        expect(c.canonicalJson).not.toMatch(/\s(?=(?:[^"]*"[^"]*")*[^"]*$)/); // no whitespace outside strings
        const parsed = JSON.parse(c.canonicalJson) as Record<string, unknown>;
        expect(Object.keys(parsed)).toEqual(["schemaVersion", "engineVersion", "rulesetVersion", "board", "score", "acceptedMoves", "revision", "rng", "status", "celebrated2048"]);
        expect(Object.keys(parsed.board as object)).toEqual(["size", "cells"]);
        expect(Object.keys(parsed.rng as object)).toEqual(["algorithm", "words"]);
        expect(c.checksum).toMatch(/^[0-9a-f]{64}$/);
        expect(createHash("sha256").update(c.canonicalJson, "utf8").digest("hex")).toBe(c.checksum);
        expect((parsed.board as { cells: unknown[] }).cells).toHaveLength(c.size * c.size);
        // decimals are strings, PRNG words are numbers
        expect(typeof parsed.score).toBe("string");
        expect((parsed.rng as { words: unknown[] }).words.every((w) => typeof w === "number")).toBe(true);
      });
      it("independent oracle reproduces the literal string and checksum", () => {
        expect(canonical(state)).toBe(c.canonicalJson);
        expect(checksum(state)).toBe(c.checksum);
      });
      it("engine serialize/stateChecksum reproduce them", () => {
        const s = engine.validateState(structuredClone(state) as unknown as GameState);
        expect(engine.serialize(s)).toBe(c.canonicalJson);
        expect(engine.stateChecksum(s)).toBe(c.checksum);
      });
      it("engine deserialize round trip is lossless and byte-stable", () => {
        const back = engine.deserialize(c.canonicalJson);
        expect(back).toEqual(state);
        expect(engine.serialize(back)).toBe(c.canonicalJson);
        expect(engine.stateChecksum(back)).toBe(c.checksum);
        expect(engine.serialize(engine.deserialize(engine.serialize(back)))).toBe(c.canonicalJson);
      });
      it("any single-field drift changes the checksum (checksum covers revision, status, celebration, rng)", () => {
        const base = checksum(state);
        const mutants: OState[] = [
          { ...state, revision: state.revision + 1 },
          { ...state, acceptedMoves: state.acceptedMoves + 1 },
          { ...state, score: state.score + "0" },
          { ...state, celebrated2048: !state.celebrated2048 },
          { ...state, status: state.status === "active" ? "completed" : "active" },
          { ...state, rng: { ...state.rng, words: [state.rng.words[0] ^ 1, state.rng.words[1], state.rng.words[2], state.rng.words[3]] as OState["rng"]["words"] } },
          { ...state, rulesetVersion: state.rulesetVersion + "x" },
        ];
        for (const m of mutants) expect(checksum(m)).not.toBe(base);
      });
    });
  }
});
