import { describe, expect, it } from "vitest";
import { LIMITS, RULESETS, SNAPSHOT_INTERVAL, practiceRuleset } from "@g2048/contracts";
import type { Direction, GameState, ReplayFile, Ruleset } from "@g2048/contracts";
import { createLocalAdapter } from "../game/local-adapter.js";
import { localEngine } from "../game/local-engine.js";
import type { EnginePort } from "../game/engine-port.js";
import type { ReplayData } from "../game/adapter.js";
import { createGuestSaveStore } from "../game/save-store.js";
import { memoryStorage } from "../test/fake-engine.js";
import { inlineAnalyzer } from "./analyzer.js";
import {
  analyzeReplayText,
  analyzeReplayValue,
  buildReplayFile,
  explainEvents,
  ReplayCursor,
  replayFileName,
} from "./replay.js";

const ORDER: Direction[] = ["left", "down", "right", "up"];
const META = { displayName: null, createdAt: "2026-10-12T00:00:00.000Z" };

/** Plays up to `count` accepted moves with a fixed preference order (deterministic for a seed). */
function play(rules: Ruleset, seed: string, count: number): ReplayData & { states: GameState[] } {
  const initial = localEngine.newGame(rules, seed);
  const moves: Direction[] = [];
  const states = [initial];
  let state = initial;
  while (moves.length < count && state.status === "active") {
    const legal = localEngine.legalMoves(state.board);
    const dir = ORDER.find((d) => legal.includes(d));
    if (!dir) break;
    state = localEngine.applyMove(state, dir, rules).state;
    moves.push(dir);
    states.push(state);
  }
  return { mode: "classic", rules, seed, initial, moves, states };
}

const classic = RULESETS["classic-v1"];
const long = play(classic, "replay-player-test", 140);
const file = buildReplayFile(localEngine, long, META);
const text = JSON.stringify(file);

function analyze(value: unknown) {
  return analyzeReplayValue(JSON.parse(JSON.stringify(value)), localEngine);
}

describe("buildReplayFile (CONTRACT-001 C12)", () => {
  it("records canonical revisions 1..n and engine checksums for every accepted move", () => {
    expect(long.moves.length).toBeGreaterThan(2 * SNAPSHOT_INTERVAL);
    expect(file.replaySchemaVersion).toBe(1);
    expect(file.rulesetVersion).toBe("classic-v1");
    expect(file.initialChecksum).toBe(localEngine.checksum(long.initial));
    expect(file.moves.map((m) => m.revision)).toEqual(long.moves.map((_, i) => i + 1));
    file.moves.forEach((m, i) => {
      expect(m.direction).toBe(long.moves[i]);
      expect(m.checksum).toBe(localEngine.checksum(long.states[i + 1] as GameState));
    });
    expect(file.finalChecksum).toBe(localEngine.checksum(long.states.at(-1) as GameState));
    expect(file.meta.source).toBe("local");
    expect(localEngine.verifyReplay(file, classic).ok).toBe(true);
    expect(replayFileName(file)).toMatch(/^2048-infinite-replay-classic-v1-2026-10-12-\d+moves\.json$/);
  });

  it("exports exact values as decimal strings and no account/session data", () => {
    expect(typeof file.initialState.score).toBe("string");
    expect(text).not.toMatch(/csrf|password|sid|gid|token/i);
  });
});

describe("analyzeReplayText (REP-01, REP-03)", () => {
  it("verifies a good replay and keeps a snapshot every SNAPSHOT_INTERVAL moves", () => {
    const result = analyzeReplayText(text, localEngine);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { replay } = result;
    expect(replay.snapshots).toHaveLength(Math.floor(long.moves.length / SNAPSHOT_INTERVAL) + 1);
    replay.snapshots.forEach((snap, k) =>
      expect(localEngine.checksum(snap)).toBe(
        localEngine.checksum(long.states[k * SNAPSHOT_INTERVAL] as GameState),
      ),
    );
    expect(localEngine.checksum(replay.final)).toBe(file.finalChecksum);
  });

  it("rejects an oversize file before parsing it", () => {
    const result = analyzeReplayText("{", localEngine, LIMITS.replayImportBytes + 1);
    expect(result).toMatchObject({ ok: false, problem: { kind: "too-large" } });
  });

  it("rejects non-JSON and JSON that isn't a replay", () => {
    expect(analyzeReplayText("not json", localEngine)).toMatchObject({ problem: { kind: "not-json" } });
    expect(analyzeReplayText('{"hello":1}', localEngine)).toMatchObject({ problem: { kind: "not-replay" } });
    expect(analyzeReplayText("[1,2]", localEngine)).toMatchObject({ problem: { kind: "not-replay" } });
  });

  it("rejects unsupported replay/engine versions with an actionable message", () => {
    const v2 = analyze({ ...file, replaySchemaVersion: 2 });
    expect(v2).toMatchObject({ ok: false, problem: { kind: "unsupported-version" } });
    if (!v2.ok) expect(v2.problem.message).toMatch(/version 2 isn't supported/);
    const engine = analyze({ ...file, engineVersion: "engine-999" });
    expect(engine).toMatchObject({ ok: false, problem: { kind: "unsupported-version" } });
  });

  it("rejects unknown rulesets and over-long replays without running them", () => {
    expect(analyze({ ...file, rulesetVersion: "mystery-v9" })).toMatchObject({
      problem: { kind: "unknown-ruleset" },
    });
    const moves = new Array(LIMITS.replayMaxMoves + 1).fill(file.moves[0]);
    expect(analyze({ ...file, moves })).toMatchObject({ problem: { kind: "too-long" } });
  });

  it("pinpoints a tampered move checksum or direction", () => {
    const moves = file.moves.map((m, i) => (i === 7 ? { ...m, checksum: "0".repeat(64) } : m));
    const bad = analyze({ ...file, moves });
    expect(bad).toMatchObject({ ok: false, problem: { kind: "corrupt" } });
    if (!bad.ok) expect(bad.problem.atMove).not.toBeNull();

    const flipped = file.moves.map((m, i) =>
      i === 3 ? { ...m, direction: m.direction === "left" ? "right" : "left" } : m,
    );
    expect(analyze({ ...file, moves: flipped })).toMatchObject({ ok: false, problem: { kind: "corrupt" } });
  });

  it("rejects a forged score in the initial state or a wrong final checksum", () => {
    const forged = analyze({ ...file, initialState: { ...file.initialState, score: "999999" } });
    expect(forged.ok).toBe(false);
    expect(analyze({ ...file, finalChecksum: "f".repeat(64) }).ok).toBe(false);
  });

  it("verifies practice replays (other sizes and four-weights)", () => {
    const rules = practiceRuleset({ size: 5, fourWeight: 4, undo: true });
    const data = { ...play(rules, "practice-replay", 30), mode: "practice" as const };
    const result = analyze(buildReplayFile(localEngine, data, META));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.replay.rules.fourWeight).toBe(4);
  });

  it("the inline analyzer (worker fallback) gives the same verdict", async () => {
    const result = await inlineAnalyzer(localEngine).analyze(text, text.length);
    expect(result.ok).toBe(true);
  });
});

describe("ReplayCursor (snapshot seek)", () => {
  const analyzed = analyzeReplayText(text, localEngine);
  if (!analyzed.ok) throw new Error("fixture replay must verify");

  it("random access matches sequential play at every probed position, in any order", () => {
    const cursor = new ReplayCursor(localEngine, analyzed.replay);
    const probes = [long.moves.length, 0, 1, 49, 50, 51, 99, 100, 101, 7, long.moves.length - 1, 60, 59];
    for (const i of probes) {
      const frame = cursor.frame(i);
      expect(frame.index).toBe(i);
      expect(localEngine.checksum(frame.state)).toBe(localEngine.checksum(long.states[i] as GameState));
      if (i > 0) expect(frame.events.length).toBeGreaterThan(0);
    }
    expect(cursor.frame(-5).index).toBe(0);
    expect(cursor.frame(1e9).index).toBe(long.moves.length);
  });

  it("seeks from the nearest snapshot instead of replaying from the start", () => {
    let applied = 0;
    const counting: EnginePort = {
      ...localEngine,
      applyMove: (s, d, r) => {
        applied++;
        return localEngine.applyMove(s, d, r);
      },
    };
    const cursor = new ReplayCursor(counting, analyzed.replay);
    const far = long.moves.length - 2;
    expect(far).toBeGreaterThan(2 * SNAPSHOT_INTERVAL);
    cursor.frame(far);
    expect(applied).toBeLessThanOrEqual(SNAPSHOT_INTERVAL);
    applied = 0;
    cursor.frame(far + 1); // stepping forward reuses the current frame
    expect(applied).toBe(1);
    applied = 0;
    cursor.frame(20); // stepping back restarts from snapshot 0, not from the far position
    expect(applied).toBeLessThanOrEqual(20);
  });
});

describe("explainEvents", () => {
  it("explains merges, spawns and slides in plain language without colour", () => {
    const lines = explainEvents(
      [
        { type: "tile.moved", from: 1, to: 0, exponent: "1" },
        { type: "tile.merged", to: 0, sources: [0, 1], exponent: "2", value: "4" },
        { type: "tile.spawned", at: 5, exponent: "1" },
        { type: "milestone.reached", exponent: "11", first2048: true },
        { type: "game.over" },
      ],
      4,
    );
    expect(lines[0]).toBe("1 tile slid.");
    expect(lines[1]).toBe("Two 2 tiles merged into 4 at row 1, column 1 (+4 points).");
    expect(lines[2]).toBe("A new 2 appeared at row 2, column 2.");
    expect(lines[3]).toMatch(/2048 reached/);
    expect(lines[4]).toMatch(/game is over/);
  });

  it("never expands astronomically large merges", () => {
    const [line] = explainEvents(
      [{ type: "tile.merged", to: 0, sources: [0, 1], exponent: "900000", value: "0" }],
      4,
    );
    expect(line!.length).toBeLessThan(400);
  });
});

describe("local adapter replay record", () => {
  it("tracks the final path (undo removes moves) and survives a reload from the save", async () => {
    const storage = memoryStorage();
    const adapter = createLocalAdapter(localEngine, createGuestSaveStore(storage));
    await adapter.start({ mode: "classic", rules: classic, seed: "adapter-replay" });
    const played: Direction[] = [];
    for (let i = 0; i < 6; i++) {
      const legal = localEngine.legalMoves(adapter.current()!.state.board);
      const dir = ORDER.find((d) => legal.includes(d))!;
      const out = await adapter.move(dir);
      if (out.ok && out.changed) played.push(dir);
    }
    await adapter.undo();
    played.pop();
    const data = adapter.replayData!()!;
    expect(data.moves).toEqual(played);

    const reloaded = createLocalAdapter(localEngine, createGuestSaveStore(storage));
    await reloaded.reload();
    const restored = reloaded.replayData!()!;
    expect(restored.moves).toEqual(played);
    const replayFile: ReplayFile = buildReplayFile(localEngine, restored, META);
    expect(replayFile.finalChecksum).toBe(localEngine.checksum(reloaded.current()!.state));
    expect(localEngine.verifyReplay(replayFile, classic).ok).toBe(true);
  });
});
