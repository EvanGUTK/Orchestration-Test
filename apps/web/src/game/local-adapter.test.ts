import { describe, expect, it } from "vitest";
import { checksum } from "@g2048/engine";
import { RULESETS, practiceRuleset } from "@g2048/contracts";
import type { Direction, GameState } from "@g2048/contracts";
import { Announcer } from "../a11y/announcer.js";
import { silentSoundPlayer } from "../lib/sound.js";
import { createFakeEngine, memoryStorage } from "../test/fake-engine.js";
import { GameController } from "./controller.js";
import { createLocalAdapter } from "./local-adapter.js";
import { localEngine } from "./local-engine.js";
import { createGuestSaveStore, GUEST_SAVE_KEY, memorySaveStore } from "./save-store.js";

const classic = RULESETS["classic-v1"];

async function playUntilChanged(adapter: ReturnType<typeof createLocalAdapter>, dirs: Direction[]) {
  for (const d of dirs) {
    const out = await adapter.move(d);
    if (out.ok && out.changed) return out;
  }
  throw new Error("no legal move found");
}

describe("local adapter on the real engine (SOLO-01 guest path)", () => {
  it("starts a classic game with two tiles and the classic ruleset", async () => {
    const adapter = createLocalAdapter(localEngine, memorySaveStore());
    const s = await adapter.start({ mode: "classic", rules: classic, seed: "frontend-test" });
    expect(s.state.board.size).toBe(4);
    expect(s.state.board.cells.filter((c) => c !== null)).toHaveLength(2);
    expect(s.state.score).toBe("0");
    expect(s.state.rulesetVersion).toBe("classic-v1");
    // Same seed -> same initial state (deterministic engine).
    const again = await createLocalAdapter(localEngine, memorySaveStore()).start({
      mode: "classic",
      rules: classic,
      seed: "frontend-test",
    });
    expect(checksum(again.state)).toBe(checksum(s.state));
  });

  it("applies moves, autosaves after each one, and resumes the exact state", async () => {
    const storage = memoryStorage();
    const adapter = createLocalAdapter(localEngine, createGuestSaveStore(storage));
    await adapter.start({ mode: "classic", rules: classic, seed: "resume" });
    const out = await playUntilChanged(adapter, ["left", "up", "right", "down"]);
    if (!out.ok) throw new Error("move failed");
    expect(out.session.state.acceptedMoves).toBe(1);
    expect(out.events.some((e) => e.type === "tile.spawned")).toBe(true);
    expect(storage.getItem(GUEST_SAVE_KEY)).not.toBeNull();

    const resumed = createLocalAdapter(localEngine, createGuestSaveStore(storage)).current();
    expect(resumed).not.toBeNull();
    expect(checksum(resumed!.state)).toBe(checksum(out.session.state));
    expect(resumed!.mode).toBe("classic");
  });

  it("ignores a corrupted save instead of trusting it", () => {
    const storage = memoryStorage();
    storage.setItem(
      GUEST_SAVE_KEY,
      JSON.stringify({
        version: 1,
        id: "x",
        mode: "classic",
        rules: classic,
        seed: null,
        state: '{"score":"1e9"}',
      }),
    );
    expect(createLocalAdapter(localEngine, createGuestSaveStore(storage)).current()).toBeNull();
  });

  it("undo restores the previous board, score and PRNG exactly", async () => {
    const adapter = createLocalAdapter(localEngine, memorySaveStore());
    const start = await adapter.start({ mode: "classic", rules: classic, seed: "undo" });
    const before = checksum(start.state);
    await playUntilChanged(adapter, ["left", "up", "right", "down"]);
    expect(adapter.current()!.undoDepth).toBe(1);
    const undone = await adapter.undo();
    expect(checksum(undone!.state)).toBe(before);
    expect(await adapter.undo()).toBeNull();
  });

  it("supports practice boards from 3x3 to 8x8", async () => {
    for (let size = 3; size <= 8; size++) {
      const rules = practiceRuleset({ size, fourWeight: 1, undo: true });
      const s = await createLocalAdapter(localEngine, memorySaveStore()).start({
        mode: "practice",
        rules,
        seed: "p",
      });
      expect(s.state.board.cells).toHaveLength(size * size);
      expect(s.state.rulesetVersion).toBe("practice-v1");
    }
  });

  it("returns NO_CHANGE-style outcomes for no-op moves without touching state", async () => {
    const adapter = createLocalAdapter(localEngine, memorySaveStore());
    const s = await adapter.start({ mode: "classic", rules: classic, seed: "noop" });
    // A board with a single tile in the top-left corner cannot move up or left.
    const cells = Array<string | null>(16).fill(null);
    cells[0] = "1";
    const pinned: GameState = { ...s.state, board: { size: 4, cells } };
    const outcome = localEngine.applyMove(pinned, "left", classic);
    expect(outcome.changed).toBe(false);
    expect(outcome.scoreDelta).toBe("0");
  });
});

describe("GameController with the real engine", () => {
  it("celebrates 2048 once, pauses input, and keeps playing afterwards", async () => {
    // Seed a near-2048 board through a real engine state, then let the real engine merge it.
    const real = localEngine.newGame(classic, "celebrate");
    const cells = Array<string | null>(16).fill(null);
    cells[0] = "10";
    cells[1] = "10";
    const near: GameState = { ...real, board: { size: 4, cells } };
    const saves = memorySaveStore();
    saves.save({
      version: 1,
      id: "g",
      mode: "classic",
      rules: classic,
      seed: "celebrate",
      state: localEngine.serialize(near),
      savedAt: "",
    });
    const announcer = new Announcer({ intervalMs: 0 });
    const spoken: string[] = [];
    announcer.subscribe((m) => spoken.push(m));
    const controller = new GameController(createLocalAdapter(localEngine, saves), {
      announcer,
      sound: silentSoundPlayer,
    });
    controller.move("left");
    controller.move("right"); // queued behind the dialog
    await controller.idle();
    const snap = controller.getSnapshot();
    expect(snap.celebrating).toBe(true);
    expect(snap.session!.state.celebrated2048).toBe(true);
    expect(snap.session!.state.board.cells[0]).toBe("11");
    expect(snap.session!.state.acceptedMoves).toBe(1);
    expect(spoken.join(" ")).toContain("New highest tile: 2048");
    expect(snap.session!.state.status).toBe("active");

    controller.keepPlaying();
    await controller.idle();
    expect(controller.getSnapshot().celebrating).toBe(false);
    expect(controller.getSnapshot().session!.state.acceptedMoves).toBe(2);
  });
});

describe("GameController with a scripted engine", () => {
  it("applies a rapid mixed burst in input order and announces the final score", async () => {
    const engine = createFakeEngine();
    const announcer = new Announcer({ intervalMs: 10_000 });
    const controller = new GameController(createLocalAdapter(engine, memorySaveStore()), {
      announcer,
      sound: silentSoundPlayer,
    });
    await controller.start({ mode: "classic", rules: classic });
    const burst: Direction[] = ["left", "left", "up", "right", "down", "down", "left", "up"];
    for (const d of burst) controller.move(d);
    controller.move("right", { repeat: true }); // held-key repeat while busy is not queued
    await controller.idle();
    expect(engine.calls).toEqual(burst);
    expect(controller.getSnapshot().session!.state.acceptedMoves).toBe(burst.length);
    expect(controller.getSnapshot().session!.state.score).toBe(String(4 * burst.length));
  });

  it("stops and clears queued input at game over (move cap or dead board)", async () => {
    const engine = createFakeEngine();
    engine.script = (_d, _s, i) => (i === 1 ? { status: "completed", events: [] } : {});
    const controller = new GameController(createLocalAdapter(engine, memorySaveStore()), {
      announcer: new Announcer({ intervalMs: 0 }),
      sound: silentSoundPlayer,
    });
    await controller.start({ mode: "classic", rules: classic });
    for (const d of ["up", "down", "left", "right"] as Direction[]) controller.move(d);
    await controller.idle();
    expect(engine.calls).toEqual(["up", "down"]);
    expect(controller.getSnapshot().session!.state.status).toBe("completed");
    expect(controller.move("left")).toBe(false);
  });

  it("keeps the last valid state on RESOURCE_LIMIT", async () => {
    const engine = createFakeEngine();
    engine.script = (_d, _s, i) => (i === 1 ? { throwCode: "RESOURCE_LIMIT" } : {});
    const controller = new GameController(createLocalAdapter(engine, memorySaveStore()), {
      announcer: new Announcer({ intervalMs: 0 }),
      sound: silentSoundPlayer,
    });
    await controller.start({ mode: "classic", rules: classic });
    controller.move("up");
    controller.move("down");
    controller.move("left");
    await controller.idle();
    const snap = controller.getSnapshot();
    expect(snap.session!.state.acceptedMoves).toBe(1);
    expect(snap.notice).toMatch(/tile limit.*1 queued move/);
  });
});
