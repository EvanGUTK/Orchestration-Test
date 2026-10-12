// REP-01 | Full replay and snapshot seek — every checksum/final state matches the original.
// REP-02 | Import/export — versions validated, exact numbers preserved, no account/session secrets.
// REP-03 | Oversize/corrupt/unknown replay — actionable rejection before data is installed.
// Spec-first: GET /replays/:id (id = game id), POST /replays/import (<= LIMITS.replayImportBytes, never ranked).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_VERSION, LIMITS, REPLAY_SCHEMA_VERSION, RULESETS } from "@g2048/contracts";
import type { GameEventsResponse, GameState, ReplayFile } from "@g2048/contracts";
import { applyMove, checksum, deserialize, verifyReplay } from "@g2048/engine";
import { createTestApp } from "./helpers/app.js";
import type { TestApp } from "./helpers/app.js";
import { createGame, getGame, legalMove, seedGameState } from "./helpers/games.js";
import { Client, expectErrorEnvelope } from "./helpers/http.js";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const PASSWORD = "correct horse battery";

async function playedGame(c: Client, seed: string, moves: number): Promise<{ id: string; state: GameState }> {
  const g = await createGame(c, { mode: "classic", seed });
  let s = g.state;
  for (let i = 0; i < moves && s.status === "active"; i++) s = await legalMove(c, g.game.id, s, i);
  return { id: g.game.id, state: s };
}

async function exportReplay(c: Client, id: string): Promise<{ file: ReplayFile; text: string }> {
  const r = await c.get<ReplayFile>(`/replays/${id}`);
  expect(r.status, r.text).toBe(200);
  return { file: r.json, text: r.text };
}

const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("REP-01 full replay and snapshot seek", () => {
  it("exported replay verifies move by move and matches the stored game, events and snapshots", async () => {
    const c = new Client(t.app);
    await c.signUp("replayer");
    const { id, state } = await playedGame(c, "rep01", 60);
    const { file } = await exportReplay(c, id);
    expect(file.replaySchemaVersion).toBe(REPLAY_SCHEMA_VERSION);
    expect(file.engineVersion).toBe(ENGINE_VERSION);
    expect(file.rulesetVersion).toBe("classic-v1");
    expect(file.seed).toBe("rep01");
    expect(file.moves).toHaveLength(state.acceptedMoves);
    expect(file.finalChecksum).toBe(checksum(state));
    expect(file.initialChecksum).toBe(checksum(file.initialState));

    // independent step-by-step verification
    let s = file.initialState;
    for (const [i, m] of file.moves.entries()) {
      s = applyMove(s, m.direction, RULESETS["classic-v1"]).state;
      expect(checksum(s), `move ${i + 1}`).toBe(m.checksum);
      expect(s.revision).toBe(m.revision);
    }
    expect(s).toEqual(state);
    const v = verifyReplay(file, RULESETS["classic-v1"]);
    expect(v.ok).toBe(true);

    // event log agrees with the replay checksums (step through a window)
    const ev = await c.get<GameEventsResponse>(`/games/${id}/events?afterRevision=10&limit=5`);
    expect(ev.status, ev.text).toBe(200);
    expect(ev.json.events.map((e) => [e.revision, e.checksum])).toEqual(
      file.moves.slice(10, 15).map((m) => [m.revision, m.checksum]),
    );

    // snapshot seek: the revision-50 snapshot + the remaining moves reproduce the final state
    const snap = t.db
      .prepare("SELECT state_json, checksum FROM game_snapshots WHERE game_id = ? AND revision = 50")
      .get(id) as { state_json: string; checksum: string } | undefined;
    expect(snap, "snapshot every 50 accepted moves").toBeDefined();
    expect(snap?.checksum).toBe(file.moves[49]?.checksum);
    let fromSnap = deserialize(snap?.state_json ?? "");
    for (const m of file.moves.slice(50))
      fromSnap = applyMove(fromSnap, m.direction, RULESETS["classic-v1"]).state;
    expect(fromSnap).toEqual(state);
  });
});

describe("REP-02 import and export", () => {
  it("export carries no credential/session material and redacts account metadata", async () => {
    const c = new Client(t.app);
    await c.signUp("secretive", PASSWORD, "Secret Agent");
    const { id } = await playedGame(c, "rep02-secrets", 10);
    const { file, text } = await exportReplay(c, id);
    for (const secret of [
      PASSWORD,
      c.jar.get("sid") ?? "<no sid>",
      c.csrfToken ?? "<no csrf>",
      "$argon2",
      "token_hash",
      "password",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/"(sid|gid|csrf\w*|sessionId|userId|accountId|username)"\s*:/i);
    expect(file.meta.source).toBe("local");
  });

  it("an exported replay imports, re-exports identically, and is never ranked", async () => {
    const c = new Client(t.app);
    await c.signUp("importer");
    const { id } = await playedGame(c, "rep02-roundtrip", 25);
    const { file } = await exportReplay(c, id);
    const boards = (q: string) => c.get<{ items: unknown[] }>(`/leaderboards?${q}`);
    const before = [
      (await boards("scope=casual&ruleset=classic-v1")).json,
      (await boards("scope=challenge")).json,
    ];

    const imp = await c.post<{ id?: string; replayId?: string }>("/replays/import", file);
    expect([200, 201], imp.text).toContain(imp.status);
    const importedId = imp.json.id ?? imp.json.replayId;
    expect(importedId).toEqual(expect.any(String));
    const again = await exportReplay(c, importedId as string);
    expect(again.file.moves).toEqual(file.moves);
    expect(again.file.initialState).toEqual(file.initialState);
    expect(again.file.finalChecksum).toBe(file.finalChecksum);
    expect(again.file.meta.source).toBe("import");
    const after = [
      (await boards("scope=casual&ruleset=classic-v1")).json,
      (await boards("scope=challenge")).json,
    ];
    expect(after).toEqual(before);
  });

  it("exact huge values survive export (a seeded high-value game)", async () => {
    const c = new Client(t.app);
    await c.signUp("bigvalues");
    const g = await createGame(c, { mode: "classic", seed: "rep02-big" });
    const cells = Array<string | null>(16).fill(null);
    cells[0] = "4095";
    cells[1] = "4095";
    cells[2] = "53";
    cells[3] = "53";
    seedGameState(t.db, g.game.id, {
      ...g.state,
      board: { size: 4, cells },
      score: (1n << 60n).toString(),
      celebrated2048: true,
    });
    const s = await legalMove(c, g.game.id, (await getGame(c, g.game.id)).state);
    const { file, text } = await exportReplay(c, g.game.id);
    expect(file.finalChecksum).toBe(checksum(s));
    expect(text).toContain(`"${s.score}"`);
    expect(s.board.cells).toContain("4096");
  });
});

describe("REP-03 oversize, corrupt and unknown replays are rejected before anything is installed", () => {
  async function baseline(c: Client): Promise<ReplayFile> {
    await c.signUp("rejector");
    const { id } = await playedGame(c, "rep03", 12);
    return (await exportReplay(c, id)).file;
  }
  const installed = () => [count(t.db, "games"), count(t.db, "replay_exports"), count(t.db, "game_moves")];

  it.each([
    [
      "unknown replay schema version",
      (f: ReplayFile) => ({ ...f, replaySchemaVersion: 99 }),
      "REPLAY_VERSION_UNSUPPORTED",
    ],
    [
      "unknown engine version",
      (f: ReplayFile) => ({ ...f, engineVersion: "9.9.9" }),
      "REPLAY_VERSION_UNSUPPORTED",
    ],
    [
      "tampered move checksum",
      (f: ReplayFile) => ({
        ...f,
        moves: f.moves.map((m, i) => (i === 5 ? { ...m, checksum: "0".repeat(64) } : m)),
      }),
      "IMPORT_INVALID",
    ],
    [
      "forged final score",
      (f: ReplayFile) => ({ ...f, initialState: { ...f.initialState, score: "999999999" } }),
      "IMPORT_INVALID",
    ],
    ["missing moves", (f: ReplayFile) => ({ ...f, moves: undefined }), "IMPORT_INVALID"],
    ["unknown ruleset", (f: ReplayFile) => ({ ...f, rulesetVersion: "mega-v9" }), "IMPORT_INVALID"],
  ])("%s -> 400 %s", async (_label, mutate, code) => {
    const c = new Client(t.app);
    const file = await baseline(c);
    const before = installed();
    const r = await c.post("/replays/import", mutate(file));
    expect(r.status, r.text).toBe(400);
    expectErrorEnvelope(r, code);
    expect(installed()).toEqual(before);
  });

  it("corrupt JSON -> 400 IMPORT_INVALID", async () => {
    const c = new Client(t.app);
    await baseline(c);
    const before = installed();
    const r = await c.post("/replays/import", '{"replaySchemaVersion":1,"moves":[', {
      headers: { "content-type": "application/json" },
    });
    expect(r.status, r.text).toBe(400);
    expectErrorEnvelope(r);
    expect(installed()).toEqual(before);
  });

  it(
    `oversize (> ${LIMITS.replayImportBytes} bytes) is refused with a typed error`,
    { timeout: 60_000 },
    async () => {
      const c = new Client(t.app);
      const file = await baseline(c);
      const before = installed();
      const padded = {
        ...file,
        meta: { ...file.meta, displayName: "x".repeat(LIMITS.replayImportBytes + 1024) },
      };
      const r = await c.post("/replays/import", padded);
      expect([400, 413], r.text.slice(0, 300)).toContain(r.status);
      expectErrorEnvelope(r);
      expect(installed()).toEqual(before);
    },
  );
});
