import { describe, expect, it, vi } from "vitest";
import { CLASSIC_RULES } from "@2048/contracts";
import type { Direction, GameState, MoveCommand } from "@2048/contracts";
import * as engine from "@2048/engine";
import { ApiRequestError } from "../src/api/client.ts";
import { GameController } from "../src/game/controller.ts";
import type { GameTransport, MoveOutcome } from "../src/game/controller.ts";
import { LocalTransport } from "../src/game/transports.ts";
import { advanceTiles, createIdSource, layoutMatchesBoard, tilesFromBoard } from "../src/game/tiles.ts";
import { makeState } from "./helpers.ts";

describe("tile model", () => {
  it("follows tiles through a real engine move and matches the authoritative board", () => {
    const ids = createIdSource();
    let state = engine.newGame(CLASSIC_RULES, "tiles-seed");
    let tiles = tilesFromBoard(state.board, ids);
    for (const direction of ["left", "up", "right", "down", "left", "up", "left", "down"] as Direction[]) {
      const result = engine.applyMove(state, direction, CLASSIC_RULES);
      if (!result.changed) continue;
      tiles = advanceTiles(tiles, result.events, result.state.board, ids);
      expect(layoutMatchesBoard(tiles, result.state.board)).toBe(true);
      state = result.state;
    }
  });

  it("keeps tile identity for a sliding tile and marks merges and spawns", () => {
    const ids = createIdSource();
    const before = makeState(["1", "1", null, null, null, null, null, null, null, null, null, null, null, null, null, "2"]);
    const tiles = tilesFromBoard(before.board, ids);
    const result = engine.applyMove(before, "left", CLASSIC_RULES);
    const next = advanceTiles(tiles, result.events, result.state.board, ids);
    const live = next.filter((t) => !t.leaving);
    expect(live.find((t) => t.merged)?.exponent).toBe("2");
    expect(live.filter((t) => t.fresh)).toHaveLength(1);
    expect(next.some((t) => t.leaving)).toBe(true);
    const slid = tiles.find((t) => t.index === 15);
    expect(live.find((t) => t.id === slid?.id)?.index).toBe(12);
  });

  it("falls back to the authoritative board when events disagree", () => {
    const ids = createIdSource();
    const board = makeState(["3", null]).board;
    const bogus = advanceTiles(tilesFromBoard(makeState(["1"]).board, ids), [], board, ids);
    expect(layoutMatchesBoard(bogus, board)).toBe(true);
  });
});

function transportWith(handler: (cmd: MoveCommand, current: GameState) => Promise<MoveOutcome>, load?: () => Promise<GameState>): GameTransport {
  return {
    kind: "remote",
    move: handler,
    load: async () => ({ state: load ? await load() : makeState([]) }),
  };
}

function appliedOutcome(state: GameState, direction: Direction): MoveOutcome {
  return { state: { ...state, revision: state.revision + 1, acceptedMoves: state.acceptedMoves + 1 }, changed: true, scoreDelta: "0", events: [{ type: "spawn", index: 15, exponent: "1" }, ...(direction ? [] : [])] };
}

describe("GameController input queue", () => {
  it("applies queued moves strictly in order, one in flight, each with a unique commandId and current revision", async () => {
    const seen: MoveCommand[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const initial = makeState(["1"]);
    const transport = transportWith(async (cmd, current) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      seen.push(cmd);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return appliedOutcome(current, cmd.direction);
    });
    const controller = new GameController(initial, transport);
    const order: Direction[] = ["left", "up", "right", "down", "left"];
    for (const d of order) expect(controller.enqueue(d)).toBe(true);
    await vi.waitFor(() => expect(controller.getSnapshot().state.revision).toBe(5));
    expect(seen.map((c) => c.direction)).toEqual(order);
    expect(seen.map((c) => c.expectedRevision)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(seen.map((c) => c.commandId)).size).toBe(5);
    expect(maxInFlight).toBe(1);
    expect(controller.getSnapshot().pending).toBe(0);
  });

  it("bounds the queue instead of dropping silently", async () => {
    const transport = transportWith(async (cmd, current) => {
      await new Promise((r) => setTimeout(r, 20));
      return appliedOutcome(current, cmd.direction);
    });
    const controller = new GameController(makeState(["1"]), transport, { maxQueue: 2 });
    expect(controller.enqueue("left")).toBe(true);
    expect(controller.enqueue("up")).toBe(true);
    expect(controller.enqueue("right")).toBe(false);
    await vi.waitFor(() => expect(controller.getSnapshot().state.revision).toBe(2));
  });

  it("retries a network failure with the SAME commandId and applies the move once", async () => {
    const seen: MoveCommand[] = [];
    let calls = 0;
    const transport = transportWith(async (cmd, current) => {
      seen.push(cmd);
      calls++;
      if (calls === 1) throw new ApiRequestError("NETWORK", "down", 0, null);
      return appliedOutcome(current, cmd.direction);
    });
    const controller = new GameController(makeState(["1"]), transport, { retryDelayMs: 1 });
    controller.enqueue("left");
    await vi.waitFor(() => expect(controller.getSnapshot().state.revision).toBe(1));
    expect(seen).toHaveLength(2);
    expect(seen[1]?.commandId).toBe(seen[0]?.commandId);
    expect(controller.getSnapshot().state.acceptedMoves).toBe(1);
  });

  it("recovers from a revision conflict by reloading and re-issuing a NEW command", async () => {
    const seen: MoveCommand[] = [];
    const server = makeState(["1"], { revision: 7, acceptedMoves: 7 });
    const transport: GameTransport = {
      kind: "remote",
      async move(cmd, current) {
        seen.push(cmd);
        if (cmd.expectedRevision !== 7) throw new ApiRequestError("REVISION_CONFLICT", "stale", 409, "r");
        return appliedOutcome(current, cmd.direction);
      },
      async load() {
        return { state: server };
      },
    };
    const controller = new GameController(makeState(["1"]), transport);
    controller.enqueue("down");
    await vi.waitFor(() => expect(controller.getSnapshot().state.revision).toBe(8));
    expect(seen.map((c) => c.expectedRevision)).toEqual([0, 7]);
    expect(seen[0]?.commandId).not.toBe(seen[1]?.commandId);
  });

  it("surfaces a hard failure, drops nothing silently, and allows retry", async () => {
    let fail = true;
    const transport = transportWith(async (cmd, current) => {
      if (fail) throw new ApiRequestError("RATE_LIMITED", "slow down", 429, null);
      return appliedOutcome(current, cmd.direction);
    });
    const controller = new GameController(makeState(["1"]), transport);
    controller.enqueue("left");
    await vi.waitFor(() => expect(controller.getSnapshot().error).not.toBeNull());
    expect(controller.getSnapshot().pending).toBe(1);
    expect(controller.enqueue("up")).toBe(false); // blocked while in error so order cannot change
    fail = false;
    controller.retry();
    await vi.waitFor(() => expect(controller.getSnapshot().state.revision).toBe(1));
    expect(controller.getSnapshot().error).toBeNull();
  });

  it("does not change anything for a no-op move", async () => {
    const transport = transportWith(async (_cmd, current) => ({ state: current, changed: false, scoreDelta: "0", events: [] }));
    const controller = new GameController(makeState(["1"]), transport);
    controller.enqueue("left");
    await vi.waitFor(() => expect(controller.getSnapshot().lastMove?.seq).toBe(1));
    expect(controller.getSnapshot().state.revision).toBe(0);
    expect(controller.getSnapshot().lastMove?.changed).toBe(false);
  });

  it("fires the 2048 celebration exactly once and never regresses on stale pushes", async () => {
    const initial = makeState(["10", "10"], { revision: 0 });
    const real = new LocalTransport(initial, CLASSIC_RULES);
    const controller = new GameController(initial, real);
    controller.enqueue("left");
    await vi.waitFor(() => expect(controller.getSnapshot().celebrate).toBe(true));
    controller.dismissCelebration();
    expect(controller.getSnapshot().celebrate).toBe(false);
    expect(controller.getSnapshot().state.status).toBe("active");
    const rev = controller.getSnapshot().state.revision;
    controller.receive(makeState([], { revision: rev - 1 }));
    expect(controller.getSnapshot().state.revision).toBe(rev);
  });
});

describe("LocalTransport with the real engine", () => {
  it("plays deterministic moves and supports undo with a monotone revision", async () => {
    const initial = engine.newGame(CLASSIC_RULES, "local-seed");
    const controller = new GameController(initial, new LocalTransport(initial, CLASSIC_RULES));
    for (const d of ["left", "up", "right", "down", "left", "up"] as Direction[]) controller.enqueue(d);
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(0));
    const after = controller.getSnapshot();
    expect(after.state.acceptedMoves).toBeGreaterThan(0);
    const accepted = after.state.acceptedMoves;
    expect(after.undoAvailable).toBe(accepted);
    await controller.undo();
    const undone = controller.getSnapshot();
    expect(undone.state.acceptedMoves).toBe(accepted - 1);
    expect(undone.state.revision).toBe(after.state.revision + 1);
    expect(layoutMatchesBoard(undone.tiles, undone.state.board)).toBe(true);
  });
});
