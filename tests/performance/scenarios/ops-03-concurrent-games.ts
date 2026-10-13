// OPS-03 | 32 concurrent synthetic local games, 10,000 accepted commands — p95 < 100ms authoritative
// response; no loss/duplicates/deadlock. Runs against the PRODUCTION build (node apps/server/dist/main.js)
// on a spare loopback port with a private database under build/perf-data/.
// 32 concurrent games: 16 isolated guest identities (own cookie jars), each with two "tabs" (clients sharing
// that guest's cookies) playing their own classic game, one command in flight per game, until 10,000
// accepted moves exist in total. 16 identities because the product rate-limits new guest sessions to
// 30/min per client address and every generator client shares 127.0.0.1 (a control we do not bypass).
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { RULESETS } from "@g2048/contracts";
import type { Direction, GameResponse, GameState, MoveResponse } from "@g2048/contracts";
import { applyMove, legalMoves, newGame } from "@g2048/engine";
import { Client } from "../../integration/helpers/http.js";
import { PERCENTILE_METHOD, check, summarize, threshold } from "../lib/report.js";
import type { Scenario } from "../lib/report.js";
import { privateDataDir, startProdServer } from "../lib/server.js";

const CLIENTS = 32;
const IDENTITIES = 16;
const TARGET = Number(process.env.PERF_OPS03_COMMANDS ?? 10_000);
const WARMUP_MOVES = 320; // 10 per client, excluded from samples
const DEADLINE_MS = 15 * 60_000;
const rules = RULESETS["classic-v1"];

type GameLog = { id: string; seed: string; directions: Direction[]; state: GameState };
let cmdSeq = 0;
const commandId = (c: number) => `ops03-${c}-${++cmdSeq}-${Date.now().toString(36)}`;

export const scenario: Scenario = {
  id: "OPS-03",
  title: "32 concurrent local games, 10,000 accepted commands (production build)",
  async run() {
    const dataDir = privateDataDir("ops03");
    const server = await startProdServer(dataDir);
    const latencies: number[] = [];
    const statusCounts: Record<string, number> = {};
    const games: GameLog[] = [];
    let accepted = 0;
    let warm = 0;
    let deadlocked = false;
    const t0 = performance.now();
    try {
      const clients = Array.from({ length: CLIENTS }, () => new Client({ port: server.port }));
      const firstGames: (GameLog | null)[] = Array.from({ length: CLIENTS }, () => null);
      const create = async (ci: number, seed: string): Promise<GameLog> => {
        const r = await (clients[ci] as Client).post<GameResponse>("/games", { mode: "classic", seed });
        if (r.status !== 201) throw new Error(`create game: ${r.status} ${r.text}`);
        const g = { id: r.json.game.id, seed, directions: [], state: r.json.state };
        games.push(g);
        return g;
      };
      // setup (untimed): tab A mints the guest with its first game; tab B adopts that guest's cookies
      for (let id = 0; id < IDENTITIES; id++) {
        const a = id * 2;
        const b = a + 1;
        firstGames[a] = await create(a, `ops03-c${a}-g0`);
        for (const [k, v] of (clients[a] as Client).jar) (clients[b] as Client).jar.set(k, v);
        firstGames[b] = await create(b, `ops03-c${b}-g0`);
      }

      const play = async (ci: number) => {
        let game: GameLog | null = firstGames[ci] ?? null;
        let n = 1;
        const c = clients[ci] as Client;
        while (accepted < TARGET) {
          if (performance.now() - t0 > DEADLINE_MS) {
            deadlocked = true;
            return;
          }
          if (!game || game.state.status !== "active") game = await create(ci, `ops03-c${ci}-g${n++}`);
          const legal = legalMoves(game.state.board);
          const d = legal[(game.state.revision + ci) % legal.length] as Direction;
          const isWarm = warm < WARMUP_MOVES;
          if (isWarm) warm += 1;
          const s0 = performance.now();
          const r = await c.post<MoveResponse>(`/games/${game.id}/moves`, {
            commandId: commandId(ci),
            expectedRevision: game.state.revision,
            direction: d,
          });
          const dt = performance.now() - s0;
          statusCounts[String(r.status)] = (statusCounts[String(r.status)] ?? 0) + 1;
          if (r.status === 200 && r.json.changed) {
            game.directions.push(d);
            game.state = r.json.state;
            if (!isWarm) {
              latencies.push(dt);
              accepted += 1;
            }
          } else if (r.status === 503) {
            continue; // DB_BUSY is a legitimate bounded refusal; counted, retried with a new command
          } else {
            throw new Error(`unexpected move response ${r.status} ${r.text}`);
          }
        }
      };
      await Promise.all(clients.map((_, i) => play(i)));
      const wallMs = performance.now() - t0;

      // Correctness: each game's authoritative state == engine replay of its acknowledged moves.
      let mismatches = 0;
      let checkedMoves = 0;
      const verifier = clients[0] as Client;
      for (const g of games) {
        let s = newGame(rules, g.seed);
        for (const d of g.directions) s = applyMove(s, d, rules).state;
        checkedMoves += g.directions.length;
        const owner = clients[Number(/-c(\d+)-/.exec(g.seed)?.[1])] ?? verifier;
        const r = await owner.get<GameResponse>(`/games/${g.id}`);
        if (r.status !== 200 || JSON.stringify(r.json.state) !== JSON.stringify(s)) mismatches += 1;
      }
      await server.stop();

      const db = new DatabaseSync(server.dbPath);
      let integrity = "unknown";
      let dbMoves = -1;
      let dupCommands = -1;
      try {
        integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
          .integrity_check;
        dbMoves = (
          db.prepare("SELECT COUNT(*) AS n FROM game_moves WHERE kind = 'move'").get() as { n: number }
        ).n;
        dupCommands = (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM (SELECT game_id, revision FROM game_moves GROUP BY 1, 2 HAVING COUNT(*) > 1)",
            )
            .get() as {
            n: number;
          }
        ).n;
      } finally {
        db.close();
      }
      const s = summarize(latencies);
      const ackTotal = games.reduce((x, g) => x + g.directions.length, 0);
      return {
        id: "OPS-03",
        title: this.title,
        kind: TARGET === 10_000 ? "result" : "smoke",
        dataset: `${CLIENTS} concurrent game loops (${IDENTITIES} guest identities x 2 tabs), ${games.length} classic games (seeds ops03-c<client>-g<n>), deterministic legal moves`,
        warmup: `first ${WARMUP_MOVES} accepted moves (10 per client on average) excluded from samples`,
        rawSampleCount: s.count,
        percentileMethod: PERCENTILE_METHOD,
        metrics: {
          authoritativeMoveResponseMs: s,
          wallClockMs: Math.round(wallMs),
          acceptedCommandsMeasured: accepted,
          acceptedCommandsTotalInclWarmup: ackTotal,
          httpStatusCounts: statusCounts,
          throughputCommandsPerSec: Math.round(ackTotal / (wallMs / 1000)),
          serverPid: server.pid,
          dataDir,
          transport: "HTTP/1.1 keep-alive over 127.0.0.1, one in-flight command per client",
        },
        thresholds: [threshold("p95 authoritative move response", "< 100 ms", s.p95, s.p95 < 100)],
        correctness: [
          check(`${TARGET} accepted commands measured`, accepted >= TARGET, `${accepted}`),
          check(
            "no deadlock (finished before the 15-minute deadline)",
            !deadlocked,
            `${Math.round(wallMs)} ms`,
          ),
          check(
            "no lost/duplicate moves: every game's server state == engine replay of its acknowledged moves",
            mismatches === 0,
            `${games.length} games, ${checkedMoves} moves, ${mismatches} mismatches`,
          ),
          check(
            "database move rows == acknowledged moves",
            dbMoves === ackTotal,
            `db ${dbMoves} vs acknowledged ${ackTotal}`,
          ),
          check("no duplicate (game, revision) move rows", dupCommands === 0, `${dupCommands}`),
          check("integrity_check after shutdown", integrity === "ok", integrity),
        ],
        notMeasured: [],
        notes: [
          "Latency = client-observed HTTP round trip for POST /games/:id/moves (includes loopback network, JSON, auth/CSRF, transaction, commit).",
          "Load generator and server share the same machine; the generator runs in this Node process.",
        ],
      };
    } finally {
      if (server.child.exitCode === null) await server.stop();
    }
  },
};
