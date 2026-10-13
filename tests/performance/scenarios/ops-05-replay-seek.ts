// OPS-05 (engine/client side) | 100,000-event replay/history — p95 seek < 250ms using snapshots.
// Dataset: ONE 8x8 practice game played with a fixed corner strategy until its move stream has produced
// >= 100,000 domain events (~23.5k accepted moves). Snapshots every 50 accepted moves are stored the way
// the server stores them (canonical JSON via engine.serialize). A seek to revision r = deserialize the
// nearest snapshot <= r, then apply the remaining (< 50) moves. Compared against full replay from the
// initial state. Server-side seek (GET /replays, events paging) follows BACKEND-004; UI virtualization
// ("no full-history DOM explosion") is covered by frontend tests / e2e later.
import { performance } from "node:perf_hooks";
import { SNAPSHOT_INTERVAL, practiceRuleset } from "@g2048/contracts";
import type { Direction, GameState } from "@g2048/contracts";
import { applyMove, checksum, deserialize, legalMoves, newGame, serialize } from "@g2048/engine";
import { PERCENTILE_METHOD, check, mulberry32, summarize, threshold } from "../lib/report.js";
import type { Scenario } from "../lib/report.js";

const EVENTS = 100_000;
const SEEKS = 1_000;
const FULL_REPLAYS = 60;
const rules = practiceRuleset({ size: 8, fourWeight: 1, undo: false });
const ORDER: Direction[] = ["down", "left", "right", "up"];

export const scenario: Scenario = {
  id: "OPS-05",
  title: "100,000-event replay: snapshot seek vs full replay (engine side)",
  async run() {
    // build the history
    const initial = newGame(rules, "ops05-history");
    const moves: Direction[] = [];
    const checksums: string[] = [checksum(initial)];
    const snapshots = new Map<number, string>([[0, serialize(initial)]]);
    let s: GameState = initial;
    let events = 0;
    const b0 = performance.now();
    while (events < EVENTS && s.status === "active") {
      const legal = legalMoves(s.board);
      const d = ORDER.find((x) => legal.includes(x)) as Direction;
      const r = applyMove(s, d, rules);
      s = r.state;
      events += r.events.length;
      moves.push(d);
      checksums.push(checksum(s));
      if (moves.length % SNAPSHOT_INTERVAL === 0) snapshots.set(moves.length, serialize(s));
    }
    const buildMs = performance.now() - b0;
    const total = moves.length;

    const seek = (target: number): GameState => {
      const base = target - (target % SNAPSHOT_INTERVAL);
      let st = deserialize(snapshots.get(base) as string);
      for (let i = base; i < target; i++) st = applyMove(st, moves[i] as Direction, rules).state;
      return st;
    };
    const fullReplay = (target: number): GameState => {
      let st = initial;
      for (let i = 0; i < target; i++) st = applyMove(st, moves[i] as Direction, rules).state;
      return st;
    };

    const rnd = mulberry32(20261012);
    const targets = Array.from({ length: SEEKS }, () => Math.floor(rnd() * (total + 1)));
    for (const t of targets.slice(0, 50)) seek(t); // warmup
    const seekMs: number[] = [];
    let seekMismatches = 0;
    for (const t of targets) {
      const t0 = performance.now();
      const st = seek(t);
      seekMs.push(performance.now() - t0);
      if (checksum(st) !== checksums[t]) seekMismatches += 1;
    }
    const fullMs: number[] = [];
    let fullMismatches = 0;
    for (const t of targets.slice(0, FULL_REPLAYS)) {
      const t0 = performance.now();
      const st = fullReplay(t);
      fullMs.push(performance.now() - t0);
      if (checksum(st) !== checksums[t]) fullMismatches += 1;
    }
    const seekS = summarize(seekMs);
    const fullS = summarize(fullMs);
    return {
      id: "OPS-05",
      title: this.title,
      kind: "partial",
      dataset: `one 8x8 practice game (seed ops05-history, fourWeight 1, corner strategy down>left>right>up): ${total} accepted moves, ${events} domain events, ${snapshots.size} snapshots (every ${SNAPSHOT_INTERVAL})`,
      warmup: "50 untimed seeks; history built untimed",
      rawSampleCount: seekS.count,
      percentileMethod: PERCENTILE_METHOD,
      metrics: {
        seekWithSnapshotsMs: seekS,
        fullReplaySeekMs: fullS,
        seekTargets: `${SEEKS} uniform random revisions in [0, ${total}] (mulberry32 seed 20261012); full replay timed on the first ${FULL_REPLAYS}`,
        historyBuildMs: Math.round(buildMs),
        serializedSnapshotBytesTotal: [...snapshots.values()].reduce((x, v) => x + v.length, 0),
      },
      thresholds: [
        threshold("p95 seek using snapshots", "< 250 ms", seekS.p95, seekS.p95 < 250),
        threshold(
          "p95 full-replay seek (comparison only)",
          "informational",
          fullS.p95,
          null,
          "not an acceptance target",
        ),
      ],
      correctness: [
        check(
          "history reached 100,000 events in one game",
          events >= EVENTS,
          `${events} events, ${total} moves`,
        ),
        check(
          "every snapshot seek reproduces the recorded checksum",
          seekMismatches === 0,
          `${seekMismatches}/${SEEKS} mismatches`,
        ),
        check("full replay agrees", fullMismatches === 0, `${fullMismatches}/${FULL_REPLAYS} mismatches`),
      ],
      notMeasured: [
        "Server-side seek via GET /replays/:id + snapshots in SQLite (BACKEND-004 not integrated yet)",
        "UI: no full-history DOM/render explosion (frontend/e2e scope)",
      ],
      notes: ["Seek time includes deserialize(snapshot JSON) + up to 49 applyMove calls."],
    };
  },
};
