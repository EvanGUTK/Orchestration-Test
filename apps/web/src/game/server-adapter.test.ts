import { describe, expect, it, vi } from "vitest";
import { RULESETS, practiceRuleset } from "@g2048/contracts";
import type { Direction, GameState } from "@g2048/contracts";
import { newGame } from "@g2048/engine";
import { Announcer } from "../a11y/announcer.js";
import { ApiClient } from "../api/client.js";
import { silentSoundPlayer } from "../lib/sound.js";
import { ADA, createFakeServer } from "../test/fake-server.js";
import type { FakeServer } from "../test/fake-server.js";
import { GameController } from "./controller.js";
import { ServerGameAdapter } from "./server-adapter.js";

const instant = () => Promise.resolve();
const classic = RULESETS["classic-v1"];

/** A board where every direction is always a changed move for a while: one 2 tile in the middle. */
function spaciousState(): GameState {
  const base = newGame(classic, "server-tests");
  const cells: (string | null)[] = Array(16).fill(null);
  cells[5] = "1";
  return { ...base, board: { size: 4, cells } };
}

function setup(server: FakeServer = createFakeServer({ user: ADA })) {
  const api = new ApiClient({ fetch: server.fetch });
  const onUnauthenticated = vi.fn();
  const adapter = new ServerGameAdapter(api, { sleep: instant, delays: [1, 1, 1], onUnauthenticated });
  const controller = new GameController(adapter, {
    announcer: new Announcer({ intervalMs: 0 }),
    sound: silentSoundPlayer,
  });
  return { server, api, adapter, controller, onUnauthenticated };
}

const moveRequests = (server: FakeServer) =>
  server.requests
    .filter((r) => r.path.endsWith("/moves"))
    .map((r) => r.body as { commandId: string; expectedRevision: number; direction: Direction });

describe("ServerGameAdapter (account play)", () => {
  it("creates classic and practice games through POST /games", async () => {
    const { adapter, server } = setup();
    const classicGame = await adapter.start({ mode: "classic", rules: classic });
    expect(classicGame.authority).toBe("server");
    expect(classicGame.state.board.size).toBe(4);
    const practice = await adapter.start({
      mode: "practice",
      rules: practiceRuleset({ size: 6, fourWeight: 3, undo: false }),
      seed: "abc",
    });
    expect(practice.state.board.size).toBe(6);
    expect(server.requests.filter((r) => r.path === "/games").map((r) => r.body)).toEqual([
      { mode: "classic" },
      { mode: "practice", practice: { size: 6, fourWeight: 3, undo: false, seed: "abc" } },
    ]);
  });

  it("applies a rapid burst exactly once each, in order, with unique commandIds and chained revisions", async () => {
    const { server, adapter, controller } = setup();
    const id = server.seedGame(spaciousState());
    await controller.load(() => adapter.open(id));
    const burst: Direction[] = ["left", "right", "up", "down", "left", "up"];
    for (const d of burst) controller.move(d);
    await controller.idle();
    const sent = moveRequests(server);
    const changed = server.applied.get(id) ?? [];
    expect(sent.map((m) => m.direction)).toEqual(burst);
    expect(new Set(sent.map((m) => m.commandId)).size).toBe(burst.length);
    expect(sent.every((m) => /^[A-Za-z0-9_-]{8,64}$/.test(m.commandId))).toBe(true);
    // Each request expects the revision produced by the previous one.
    const final = controller.getSnapshot().session!.state;
    expect(final.revision).toBe(server.games.get(id)!.state.revision);
    expect(final.acceptedMoves).toBe(changed.length);
  });

  it("re-sends the SAME commandId when a committed move's response is lost, so it applies once", async () => {
    const { server, adapter, controller } = setup();
    const id = server.seedGame(spaciousState());
    await controller.load(() => adapter.open(id));
    server.faults.dropResponseAfterCommit = 1;
    controller.move("left");
    controller.move("right");
    await controller.idle();
    const sent = moveRequests(server);
    expect(sent).toHaveLength(3); // left (lost), left again (replayed), right
    expect(sent[0]!.commandId).toBe(sent[1]!.commandId);
    expect(server.applied.get(id)).toEqual(["left", "right"]);
    expect(controller.getSnapshot().session!.state.acceptedMoves).toBe(2);
  });

  it("retries DB_BUSY with backoff without double-applying", async () => {
    const { server, adapter, controller, api } = setup();
    const id = server.seedGame(spaciousState());
    await controller.load(() => adapter.open(id));
    server.faults.dbBusy = 2;
    controller.move("down");
    await controller.idle();
    expect(server.applied.get(id)).toEqual(["down"]);
    expect(new Set(moveRequests(server).map((m) => m.commandId)).size).toBe(1);
    expect(api.connection.get().kind).toBe("online");
  });

  it("keeps the failed move and everything queued behind it when the server stays unreachable", async () => {
    const { server, adapter, controller } = setup();
    const id = server.seedGame(spaciousState());
    await controller.load(() => adapter.open(id));
    server.faults.offline = true;
    for (const d of ["left", "up", "right"] as Direction[]) controller.move(d);
    await controller.idle();
    let snap = controller.getSnapshot();
    expect(snap.stalled?.waiting).toBe(3);
    expect(adapter.pendingCommand?.direction).toBe("left");
    expect(server.applied.get(id)).toBeUndefined();

    server.faults.offline = false;
    controller.retryStalled();
    await controller.idle();
    snap = controller.getSnapshot();
    expect(snap.stalled).toBeNull();
    expect(server.applied.get(id)).toEqual(["left", "up", "right"]);
  });

  it("discarding waiting moves re-reads the truth: a committed-but-unacknowledged move is kept once", async () => {
    const server = createFakeServer({ user: ADA });
    const id = server.seedGame(spaciousState());
    // The first move commits but its response is lost; afterwards /moves stays unreachable.
    const realFetch = server.fetch;
    let lost = false;
    server.fetch = async (input, init) => {
      if (lost && String(input).endsWith("/moves")) throw new TypeError("Failed to fetch");
      try {
        return await realFetch(input, init);
      } catch (e) {
        lost = true;
        throw e;
      }
    };
    server.faults.dropResponseAfterCommit = 1;
    const { adapter, controller } = setup(server);
    await controller.load(() => adapter.open(id));
    controller.move("left");
    controller.move("right");
    await controller.idle();
    expect(controller.getSnapshot().stalled?.waiting).toBe(2);
    await controller.discardStalled();
    const snap = controller.getSnapshot();
    expect(snap.stalled).toBeNull();
    expect(server.applied.get(id)).toEqual(["left"]);
    expect(snap.session!.state.revision).toBe(server.games.get(id)!.state.revision);
    expect(snap.notice).toMatch(/2 waiting move/);
  });

  it("on REVISION_CONFLICT refetches and replays the move once against the new revision", async () => {
    const { server, adapter, controller } = setup();
    const id = server.seedGame(spaciousState());
    await controller.load(() => adapter.open(id));
    server.externalMove(id, "up"); // another tab moved
    controller.move("left");
    await controller.idle();
    const sent = moveRequests(server);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.commandId).not.toBe(sent[1]!.commandId);
    expect(sent[1]!.expectedRevision).toBe(sent[0]!.expectedRevision + 1);
    expect(server.applied.get(id)).toEqual(["left"]);
    expect(controller.getSnapshot().session!.state.revision).toBe(server.games.get(id)!.state.revision);
  });

  it("shows a valid no-op as NO_CHANGE without counting a move", async () => {
    const { server, adapter, controller } = setup();
    const base = newGame(classic, "noop");
    const cells: (string | null)[] = Array(16).fill(null);
    cells[0] = "1";
    const id = server.seedGame({ ...base, board: { size: 4, cells } });
    await controller.load(() => adapter.open(id));
    controller.move("left");
    await controller.idle();
    const snap = controller.getSnapshot();
    expect(snap.notice).toBe("No tiles can move left.");
    expect(snap.session!.state.acceptedMoves).toBe(0);
    expect(server.applied.get(id)).toBeUndefined();
  });

  it("reports 401 so the app can prompt sign-in, and cancels queued moves", async () => {
    const { server, adapter, controller, onUnauthenticated } = setup();
    const id = server.seedGame(spaciousState());
    await controller.load(() => adapter.open(id));
    server.faults.unauthenticated = true;
    controller.move("left");
    controller.move("up");
    await controller.idle();
    expect(onUnauthenticated).toHaveBeenCalled();
    const snap = controller.getSnapshot();
    expect(snap.errorCode).toBe("UNAUTHENTICATED");
    expect(snap.notice).toMatch(/signed out.*1 queued move/);
  });

  it("undoes and forfeits via revision commands", async () => {
    const { server, adapter, controller } = setup();
    const id = server.seedGame(spaciousState());
    await controller.load(() => adapter.open(id));
    controller.move("left");
    await controller.idle();
    expect(controller.getSnapshot().session!.canUndo).toBe(true);
    controller.undo();
    await controller.idle();
    expect(controller.getSnapshot().session!.state.acceptedMoves).toBe(0);
    controller.forfeit();
    await controller.idle();
    expect(controller.getSnapshot().session!.state.status).toBe("forfeited");
    expect(server.games.get(id)!.state.status).toBe("forfeited");
    expect(controller.move("up")).toBe(false);
  });
});
