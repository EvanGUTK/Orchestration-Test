// DB-02 | Mid-move process termination — recovery exposes the entire previous or next transaction,
// no partial score/event. The real server runs as a child process over a private DB; we stream moves
// and hard-kill it (TerminateProcess/SIGKILL) at different moments, then inspect SQLite directly and
// via the restarted server.
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { RULESETS } from "@g2048/contracts";
import type { Direction, GameState } from "@g2048/contracts";
import { applyMove, checksum, legalMoves, newGame } from "@g2048/engine";
import { makeTempDir } from "./helpers/app.js";
import { createGame, getGame, move } from "./helpers/games.js";
import { Client } from "./helpers/http.js";
import { startServerProcess } from "./helpers/server-process.js";
import type { ServerProcess } from "./helpers/server-process.js";

const SEED = "db02-crash-seed";
const KILL_DELAYS_MS = [40, 120, 250, 400];
const tmp = makeTempDir("g2048-db02-");
const servers: ServerProcess[] = [];
afterAll(async () => {
  for (const s of servers) await s.kill();
  tmp.cleanup();
});

type Snapshot = {
  revision: number;
  score: string;
  moves: { revision: number; direction: Direction; score_delta: string; checksum: string }[];
};

function inspect(dbPath: string, gameId: string): Snapshot & { row: Record<string, unknown> } {
  const db = new DatabaseSync(dbPath);
  try {
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe(
      "ok",
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const row = db.prepare("SELECT * FROM games WHERE id = ?").get(gameId) as Record<string, unknown>;
    const moves = db
      .prepare(
        "SELECT revision, direction, score_delta, checksum FROM game_moves WHERE game_id = ? AND kind = 'move' ORDER BY revision",
      )
      .all(gameId) as Snapshot["moves"];
    const commands = db
      .prepare("SELECT COUNT(*) AS n FROM game_commands WHERE game_id = ? AND outcome = 'applied'")
      .get(gameId) as { n: number };
    expect(commands.n, "one applied command per stored move").toBe(moves.length);
    return { row, revision: Number(row.revision), score: String(row.score), moves };
  } finally {
    db.close();
  }
}

/** Replays the stored move stream with the engine; the stored state must be exactly its result. */
function verifyCoherent(s: ReturnType<typeof inspect>): GameState {
  const rules = RULESETS["classic-v1"];
  let state = newGame(rules, SEED);
  let score = 0n;
  expect(s.moves.map((m) => m.revision)).toEqual(Array.from({ length: s.moves.length }, (_, i) => i + 1));
  for (const m of s.moves) {
    const r = applyMove(state, m.direction, rules);
    expect(r.changed).toBe(true);
    state = r.state;
    expect(m.score_delta).toBe(r.scoreDelta);
    expect(m.checksum, `checksum at revision ${m.revision}`).toBe(checksum(state));
    score += BigInt(r.scoreDelta);
  }
  expect(s.revision, "games.revision == number of stored moves").toBe(s.moves.length);
  expect(s.score, "games.score == sum of stored deltas").toBe(score.toString());
  expect(s.row.state_checksum, "games.state_checksum == replayed state").toBe(checksum(state));
  expect(JSON.parse(String(s.row.board_json))).toEqual(state.board);
  return state;
}

describe("DB-02 mid-move process termination", () => {
  it(
    "hard kills during a stream of moves never leave a partial transaction",
    { timeout: 180_000 },
    async () => {
      let server = await startServerProcess(tmp.dir);
      servers.push(server);
      let client = new Client({ port: server.port });
      const created = await createGame(client, { mode: "classic", seed: SEED });
      const gameId = created.game.id;
      expect(created.state).toEqual(newGame(RULESETS["classic-v1"], SEED));

      for (const delay of KILL_DELAYS_MS) {
        let acknowledged = (await getGame(client, gameId)).state;
        let stop = false;
        const pump = (async () => {
          while (!stop) {
            const legal = legalMoves(acknowledged.board);
            const d = legal[acknowledged.revision % legal.length];
            if (!d) break;
            try {
              const r = await move(client, gameId, d, acknowledged.revision);
              if (r.status === 200) acknowledged = r.json.state;
              else break;
            } catch {
              break; // connection reset by the kill
            }
          }
        })();
        await new Promise((r) => setTimeout(r, delay));
        await server.kill();
        stop = true;
        await pump;

        const after = inspect(server.dbPath, gameId);
        const state = verifyCoherent(after);
        expect(after.revision, `kill after ${delay}ms: previous or next transaction`).toBeGreaterThanOrEqual(
          acknowledged.revision,
        );
        expect(after.revision).toBeLessThanOrEqual(acknowledged.revision + 1);

        server = await startServerProcess(tmp.dir);
        servers.push(server);
        const jar = client.jar;
        client = new Client({ port: server.port });
        for (const [k, v] of jar) client.jar.set(k, v);
        const resumed = await getGame(client, gameId);
        expect(resumed.state, "restarted server serves the recovered state").toEqual(state);
      }
      const final = (await getGame(client, gameId)).state;
      expect(final.revision, "the stream made progress across kills").toBeGreaterThan(KILL_DELAYS_MS.length);
      await server.stop();
    },
  );
});
