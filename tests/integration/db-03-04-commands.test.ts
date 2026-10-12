// DB-03 | Duplicate command ID — identical result, one move; different payload gives conflict.
// DB-04 | Two stale clients — one accepted command; other conflict; no double spawn.
// ARCHITECTURE "Transactions and concurrency": the stored response for a command id is returned
// BEFORE the expected revision is checked; a different payload is IDEMPOTENCY_CONFLICT.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Direction, GameState } from "@g2048/contracts";
import { legalMoves } from "@g2048/engine";
import { createTestApp } from "./helpers/app.js";
import type { TestApp } from "./helpers/app.js";
import { cmd, createGame, getGame, legalMove, move, moveRows } from "./helpers/games.js";
import { Client, expectErrorEnvelope } from "./helpers/http.js";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const tiles = (s: GameState) => s.board.cells.filter((c) => c !== null).length;
const noopDirection = (s: GameState): Direction | undefined =>
  (["up", "right", "down", "left"] as const).find((d) => !legalMoves(s.board).includes(d));

describe("DB-03 duplicate command id", () => {
  it("replaying the same command returns the identical response and applies one move", async () => {
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "db03-a" });
    const d = legalMoves(g.state.board)[0] as Direction;
    const id = cmd("dup");
    const first = await move(c, g.game.id, d, 0, id);
    expect(first.status, first.text).toBe(200);
    const again = await move(c, g.game.id, d, 0, id);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    const now = await getGame(c, g.game.id);
    expect(now.state.revision).toBe(1);
    expect(moveRows(t.db, g.game.id)).toHaveLength(1);
  });

  it("the stored response wins even when the replayed command's expectedRevision is now stale", async () => {
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "db03-b" });
    const d = legalMoves(g.state.board)[0] as Direction;
    const id = cmd("dup");
    const first = await move(c, g.game.id, d, 0, id);
    await legalMove(c, g.game.id, first.json.state); // revision 2 now
    const replay = await move(c, g.game.id, d, 0, id);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    expect((await getGame(c, g.game.id)).state.revision).toBe(2);
  });

  it("same command id with a different payload is 409 IDEMPOTENCY_CONFLICT and changes nothing", async () => {
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "db03-c" });
    const legal = legalMoves(g.state.board);
    const id = cmd("dup");
    const first = await move(c, g.game.id, legal[0] as Direction, 0, id);
    expect(first.status).toBe(200);
    const other = (["up", "right", "down", "left"] as const).find((x) => x !== legal[0]) as Direction;
    const conflict = await move(c, g.game.id, other, 1, id);
    expect(conflict.status).toBe(409);
    expectErrorEnvelope(conflict, "IDEMPOTENCY_CONFLICT");
    expect((await getGame(c, g.game.id)).state).toEqual(first.json.state);
    expect(moveRows(t.db, g.game.id)).toHaveLength(1);
  });

  it("a no-op command is recorded (200, changed:false, NO_CHANGE) and replays identically without a move", async () => {
    const c = new Client(t.app);
    // search a few seeds for an initial board with a no-op direction
    let g = await createGame(c, { mode: "classic", seed: "db03-noop-0" });
    for (let i = 1; !noopDirection(g.state) && i < 50; i++) {
      g = await createGame(c, { mode: "classic", seed: `db03-noop-${i}` });
    }
    const d = noopDirection(g.state);
    expect(d, "found a board with a no-op direction").toBeDefined();
    const id = cmd("noop");
    const r1 = await move(c, g.game.id, d as Direction, 0, id);
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ changed: false, scoreDelta: "0", code: "NO_CHANGE" });
    expect(r1.json.state).toEqual(g.state);
    const r2 = await move(c, g.game.id, d as Direction, 0, id);
    expect(r2.json).toEqual(r1.json);
    expect((await getGame(c, g.game.id)).state.revision).toBe(0);
    expect(moveRows(t.db, g.game.id)).toHaveLength(0);
    const recorded = t.db
      .prepare("SELECT outcome FROM game_commands WHERE game_id = ? AND command_id = ?")
      .get(g.game.id, id) as { outcome: string } | undefined;
    expect(recorded?.outcome).toBe("no-change");
  });
});

describe("DB-04 two stale clients", () => {
  it("concurrent commands at the same expectedRevision: exactly one applies, the other is 409; one spawn", async () => {
    const owner = new Client(t.app);
    const g = await createGame(owner, { mode: "classic", seed: "db04" });
    // a second "tab" of the same guest: same cookies, own CSRF state
    const tab2 = new Client(t.app);
    for (const [k, v] of owner.jar) tab2.jar.set(k, v);

    let state = g.state;
    for (let round = 0; round < 10 && state.status === "active"; round++) {
      const legal = legalMoves(state.board);
      const a = legal[0] as Direction;
      const b = (legal[1] ?? legal[0]) as Direction;
      const [ra, rb] = await Promise.all([
        move(owner, g.game.id, a, state.revision),
        move(tab2, g.game.id, b, state.revision),
      ]);
      const statuses = [ra.status, rb.status].sort();
      expect(statuses, `round ${round}: ${ra.text} | ${rb.text}`).toEqual([200, 409]);
      const loser = ra.status === 409 ? ra : rb;
      expectErrorEnvelope(loser, "REVISION_CONFLICT");
      const winner = ra.status === 200 ? ra : rb;
      const now = (await getGame(owner, g.game.id)).state;
      expect(now).toEqual(winner.json.state);
      expect(now.revision).toBe(state.revision + 1);
      // one spawn: tiles = before - merges + 1
      const merges = winner.json.events.filter((e) => e.type === "tile.merged").length;
      expect(tiles(now)).toBe(tiles(state) - merges + 1);
      expect(winner.json.events.filter((e) => e.type === "tile.spawned")).toHaveLength(1);
      state = now;
    }
    expect(moveRows(t.db, g.game.id)).toHaveLength(state.revision);
  });

  it("a stale client retrying with a NEW command id still gets REVISION_CONFLICT (no blind overwrite)", async () => {
    const c = new Client(t.app);
    const g = await createGame(c, { mode: "classic", seed: "db04-b" });
    const s1 = await legalMove(c, g.game.id, g.state);
    const stale = await move(c, g.game.id, legalMoves(s1.board)[0] as Direction, 0, cmd("stale"));
    expect(stale.status).toBe(409);
    expectErrorEnvelope(stale, "REVISION_CONFLICT");
    expect((await getGame(c, g.game.id)).state).toEqual(s1);
  });
});
