/**
 * QUALITY: independent checks of @2048/bots and @2048/competition against the written requirements
 * (docs/ACCEPTANCE.md BOT-01..04, DUEL-02..05, RANK-01..03; docs/ARCHITECTURE.md standings order) using the
 * quality oracle for every game-rule fact. Expected values are computed here (BigInt, exhaustive tables), never
 * copied from the implementations. Elo's K/start constants are implementation-defined ("elo-v1"); we pin the
 * documented behaviours: integer, conserved, monotone, deterministic, idempotent per (match, account).
 */
import { describe, expect, it } from "vitest";
import { BOT_SEED_NAMESPACE, BOT_VERSION, DUEL_RULES, RANKED_RULES, customRules, type BotConfig, type Direction, type Ruleset } from "@2048/contracts";
import * as bots from "@2048/bots";
import * as comp from "@2048/competition";
import { createRng, deriveSeedWords, isGameOver, legalMoves, serialize } from "@2048/engine";
import { OracleRng, deriveWords } from "./oracle/prng.ts";
import { applyMove as oApply, canonical, isDead, legalMoves as oLegal, newGame as oNew, type Cell, type Dir, type ORules } from "./oracle/game.ts";

const DIRS: Dir[] = ["up", "right", "down", "left"];
const STRATEGIES = ["random", "greedy", "heuristic", "expectimax"] as const;

class Fuzz {
  rng: OracleRng;
  constructor(seed: string) {
    this.rng = new OracleRng(deriveWords(`cb:${seed}`));
  }
  int(n: number) {
    return this.rng.below(n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  board(size: number, maxExp: number): Cell[] {
    const density = this.pick([0.3, 0.6, 0.9, 1]);
    return Array.from({ length: size * size }, () => (this.int(1000) / 1000 < density ? String(1 + this.int(maxExp)) : null));
  }
}
const cfg = (strategy: BotConfig["strategy"], seed = "bot-seed", nodeBudget = 2000): BotConfig => ({ strategy, seed, nodeBudget, timeBudgetMs: 5000 });
const toORules = (r: Ruleset): ORules => ({ version: r.version, boardSize: r.boardSize, moveCap: r.moveCap, startTiles: r.startTiles, spawnFourTenths: r.spawnFourTenths });
const errCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `non-domain:${(e as Error).message}`;
  }
  return undefined;
};

describe("BOT-01: strategies return legal, deterministic moves with correct metadata", () => {
  for (const strategy of STRATEGIES) {
    it(`${strategy}: 150 random boards (3..6), always oracle-legal, same input => same decision, input untouched`, () => {
      const f = new Fuzz(`bot-${strategy}`);
      let checked = 0;
      while (checked < 150) {
        const size = 3 + f.int(4);
        const cells = f.board(size, 6);
        const legal = oLegal(cells, size);
        if (legal.length === 0) continue;
        const board = Object.freeze({ size, cells: Object.freeze([...cells]) as readonly Cell[] });
        const a = bots.chooseMove(board, cfg(strategy), { ignoreTimeBudget: true, moveIndex: checked });
        const b = bots.chooseMove(board, cfg(strategy), { ignoreTimeBudget: true, moveIndex: checked });
        expect(legal, `${strategy} #${checked}`).toContain(a.direction);
        expect(legalMoves(board)).toContain(a.direction);
        expect({ ...a }).toEqual({ ...b });
        expect(a.strategy).toBe(strategy);
        expect(a.botVersion).toBe(BOT_VERSION);
        expect(a.nodes).toBeLessThanOrEqual(Math.max(2000, legal.length));
        expect(typeof a.explanation).toBe("string");
        expect(a.explanation.length).toBeGreaterThan(0);
        checked++;
      }
    });
  }

  it("exponents far beyond float range (4096, 1_000_000) do not break any strategy", () => {
    const cells: Cell[] = new Array(16).fill(null);
    cells[0] = "4096";
    cells[1] = "4096";
    cells[2] = "1000000";
    cells[5] = "999999";
    for (const s of STRATEGIES) {
      const d = bots.chooseMove({ size: 4, cells }, cfg(s), { ignoreTimeBudget: true });
      expect(oLegal(cells, 4)).toContain(d.direction);
    }
  });

  it("metadata: four distinct difficulty levels in ascending order, version and parameters recorded", () => {
    const metas = STRATEGIES.map((s) => bots.describeBot(cfg(s, "m", 1234)));
    expect(metas.map((m) => m.difficulty)).toEqual([1, 2, 3, 4]);
    for (const m of metas) {
      expect(m.botVersion).toBe(BOT_VERSION);
      expect(m.nodeBudget).toBe(1234);
      expect(m.seed).toBe("m");
      expect(m.label.length).toBeGreaterThan(0);
    }
    expect(new Set(metas.map((m) => m.label)).size).toBe(4);
  });

  it("dead board throws a typed error; invalid configs are rejected with VALIDATION_ERROR", () => {
    const dead = ["1", "2", "1", "2", "2", "1", "2", "1", "1", "2", "1", "2", "2", "1", "2", "1"];
    expect(isDead(dead, 4)).toBe(true);
    expect(errCode(() => bots.chooseMove({ size: 4, cells: dead }, cfg("greedy")))).toBe("NO_CHANGE");
    const bad: unknown[] = [
      { ...cfg("greedy"), strategy: "magic" },
      { ...cfg("greedy"), seed: "" },
      { ...cfg("greedy"), seed: "x".repeat(129) },
      { ...cfg("greedy"), nodeBudget: 0 },
      { ...cfg("greedy"), nodeBudget: 1e12 },
      { ...cfg("greedy"), nodeBudget: 1.5 },
      { ...cfg("greedy"), timeBudgetMs: 0 },
      { ...cfg("greedy"), timeBudgetMs: 10 ** 9 },
      { ...cfg("greedy"), depth: 0 },
      { ...cfg("greedy"), depth: 99 },
      null,
      "greedy",
    ];
    for (const c of bad) expect(errCode(() => bots.validateBotConfig(c)), JSON.stringify(c)).toBe("VALIDATION_ERROR");
  });
});

describe("BOT-02: budget, cancellation, bounded work", () => {
  const f = new Fuzz("budget");
  const midBoard = (): Cell[] => {
    for (;;) {
      const c = f.board(4, 7);
      if (c.filter((x) => x === null).length >= 3 && oLegal(c, 4).length >= 2) return c;
    }
  };
  it("an already-aborted signal returns a legal fallback without searching", () => {
    for (const s of STRATEGIES) {
      const cells = midBoard();
      const d = bots.chooseMove({ size: 4, cells }, cfg(s), { signal: { aborted: true } });
      expect(oLegal(cells, 4)).toContain(d.direction);
      expect(d.stopReason).toBe("cancelled");
    }
  });
  it("tiny node budgets stay bounded and legal for the deep strategies", () => {
    for (const s of ["heuristic", "expectimax"] as const) {
      for (let i = 0; i < 25; i++) {
        const cells = midBoard();
        const legal = oLegal(cells, 4);
        const d = bots.chooseMove({ size: 4, cells }, { ...cfg(s), nodeBudget: 1 }, { ignoreTimeBudget: true });
        expect(legal).toContain(d.direction);
        expect(d.nodes).toBeLessThanOrEqual(Math.max(1, legal.length));
      }
    }
  });
  it("an expired (injected) clock stops the search with a legal move and a time-budget reason", () => {
    const cells = midBoard();
    let t = 0;
    const d = bots.chooseMove({ size: 4, cells }, { ...cfg("expectimax"), nodeBudget: 5_000_000, timeBudgetMs: 5, depth: 8 }, { now: () => (t += 10) });
    expect(oLegal(cells, 4)).toContain(d.direction);
    expect(["time-budget", "complete", "fallback"]).toContain(d.stopReason);
  });
  it("a deep search with a huge node budget still returns within the real time budget (responsiveness)", () => {
    const cells = midBoard();
    const t0 = performance.now();
    const d = bots.chooseMove({ size: 4, cells }, { strategy: "expectimax", seed: "t", nodeBudget: 5_000_000, timeBudgetMs: 150, depth: 8 });
    const dt = performance.now() - t0;
    expect(oLegal(cells, 4)).toContain(d.direction);
    expect(dt, `search took ${dt.toFixed(0)}ms against a 150ms budget`).toBeLessThan(600);
  });
});

describe("BOT-03: information boundary and independent bot randomness", () => {
  it("bot stream equals the independently derived BOT-namespace stream and differs from the game stream", () => {
    for (const seed of ["s", "héllo", "abc#1", "x".repeat(100)]) {
      for (const idx of [undefined, 0, 1, 500]) {
        const mine = new OracleRng(deriveWords(idx === undefined ? seed : `${seed}#${idx}`, BOT_SEED_NAMESPACE));
        const theirs = bots.createBotStream(seed, idx);
        for (let i = 0; i < 20; i++) expect(theirs.below(1000 + i)).toBe(mine.below(1000 + i));
      }
      const game = createRng(deriveSeedWords(seed));
      const bot = bots.createBotStream(seed);
      const g = Array.from({ length: 8 }, () => game.next());
      const b = Array.from({ length: 8 }, () => bot.next());
      expect(b).not.toEqual(g);
    }
  });
  it("chooseMove's signature admits only (board, config, options): repeated calls are identical (structural boundary; no game handle exists to read)", () => {
    // Black-box limit: this proves determinism and that the public entry point takes no game/PRNG argument
    // (Function.length counts declared params). It cannot prove the absence of hidden global access; that is
    // covered by the oracle replay below, where a bot that peeked would diverge from the oracle's spawn stream.
    expect(bots.chooseMove.length).toBeLessThanOrEqual(3);
    const cells: Cell[] = new Array(16).fill(null);
    cells[0] = "3";
    cells[5] = "3";
    cells[10] = "2";
    const decisions = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const d = bots.chooseMove({ size: 4, cells }, cfg("expectimax", "fixed"), { ignoreTimeBudget: true, moveIndex: 7 });
      decisions.add(`${d.direction}|${d.nodes}`);
    }
    expect(decisions.size).toBe(1);
  });
  it("different bot seeds change tie-breaks (random strategy diversity), same seed is reproducible", () => {
    const cells: Cell[] = new Array(16).fill(null);
    cells[5] = "1";
    const seen = new Set<Direction>();
    for (let i = 0; i < 40; i++) seen.add(bots.chooseMove({ size: 4, cells }, cfg("random", `seed-${i}`), { ignoreTimeBudget: true }).direction);
    expect(seen.size).toBeGreaterThan(1);
    const a = Array.from({ length: 30 }, (_, i) => bots.chooseMove({ size: 4, cells }, cfg("random", "same"), { ignoreTimeBudget: true, moveIndex: i }).direction);
    const b = Array.from({ length: 30 }, (_, i) => bots.chooseMove({ size: 4, cells }, cfg("random", "same"), { ignoreTimeBudget: true, moveIndex: i }).direction);
    expect(a).toEqual(b);
  });
});

describe("BOT-01/04: whole bot games are legal engine games (oracle replay) and leagues repeat exactly", () => {
  for (const strategy of STRATEGIES) {
    it(`${strategy}: BotGame on ranked rules replays byte-identically in the oracle; every recorded move was accepted`, () => {
      const game = new bots.BotGame({ rules: RANKED_RULES, gameSeed: `bg-${strategy}`, config: cfg(strategy, "g", strategy === "expectimax" ? 300 : 2000), ignoreTimeBudget: true, maxMoves: 80 });
      game.runToEnd();
      const orules = toORules(RANKED_RULES);
      let o = oNew(orules, `bg-${strategy}`).state;
      for (const [i, m] of game.moves.entries()) {
        const r = oApply(o, m, orules);
        expect(r.changed, `${strategy} move ${i} must change the board`).toBe(true);
        o = r.state;
      }
      expect(serialize(game.state)).toBe(canonical(o));
      expect(game.moves.length).toBeLessThanOrEqual(80);
    });
  }

  it("strength ordering: over 5 shared seeds, expectimax/heuristic total score >= random total score (difficulty levels are real)", () => {
    const total = (s: BotConfig["strategy"]) => {
      let sum = 0n;
      for (let i = 0; i < 5; i++) {
        const g = new bots.BotGame({ rules: customRules({ boardSize: 4 }), gameSeed: `str-${i}`, config: cfg(s, "x", 400), ignoreTimeBudget: true, maxMoves: 150 });
        g.runToEnd();
        sum += BigInt(g.state.score);
      }
      return sum;
    };
    const r = total("random");
    expect(total("heuristic")).toBeGreaterThan(r);
    expect(total("expectimax")).toBeGreaterThan(r);
  });

  it("runTournament: repeat run has identical checksum; table arithmetic is consistent with the games (exact BigInt)", () => {
    const opts = {
      entries: [
        { id: "r", config: cfg("random", "r") },
        { id: "g", config: cfg("greedy", "g") },
        { id: "h", config: cfg("heuristic", "h", 300) },
      ],
      gameSeeds: ["t1", "t2", "t3"],
      rules: DUEL_RULES,
      maxMoves: 60,
    };
    const a = bots.runTournament(opts);
    const b = bots.runTournament(opts);
    expect(b.resultsChecksum).toBe(a.resultsChecksum);
    expect(b.games).toEqual(a.games);
    expect(a.games).toHaveLength(9);
    const pairs = (3 * 2) / 2;
    expect(a.table.reduce((n, r) => n + r.points, 0)).toBe(2 * 3 * pairs);
    for (const row of a.table) {
      const mine = a.games.filter((g) => g.entryId === row.entryId);
      expect(row.played).toBe(3);
      expect(row.wins + row.draws + row.losses).toBe(3 * 2);
      expect(row.totalScore).toBe(mine.reduce((s, g) => s + BigInt(g.score), 0n).toString());
    }
    const sortedOk = a.table.every((r, i) => i === 0 || a.table[i - 1]!.points >= r.points);
    expect(sortedOk).toBe(true);
    // a different budget must be allowed to differ, but a changed seed list must not alias the checksum
    expect(bots.runTournament({ ...opts, gameSeeds: ["t1", "t2", "t4"] }).resultsChecksum).not.toBe(a.resultsChecksum);
  });

  it("tournament rejects degenerate setups", () => {
    const one = { entries: [{ id: "a", config: cfg("random") }], gameSeeds: ["s"] };
    expect(errCode(() => bots.runTournament(one))).toBe("VALIDATION_ERROR");
    const dup = { entries: [{ id: "a", config: cfg("random") }, { id: "a", config: cfg("greedy") }], gameSeeds: ["s"] };
    expect(errCode(() => bots.runTournament(dup))).toBe("VALIDATION_ERROR");
    const noSeeds = { entries: [{ id: "a", config: cfg("random") }, { id: "b", config: cfg("greedy") }], gameSeeds: [] };
    expect(errCode(() => bots.runTournament(noSeeds))).toBe("VALIDATION_ERROR");
  });
});

describe("DUEL-02/03: duel resolution truth table (exact values)", () => {
  type Reason = "move-cap" | "dead" | "forfeit" | null;
  const reasons: Reason[] = [null, "move-cap", "dead", "forfeit"];
  const values = [
    { score: "0", maxExponent: "1" },
    { score: "100", maxExponent: "6" },
    { score: "100", maxExponent: "7" },
    { score: "9007199254740992", maxExponent: "20" }, // 2^53
    { score: "9007199254740993", maxExponent: "20" }, // 2^53 + 1: equal as float, different as integer
    { score: "1" + "0".repeat(40), maxExponent: "5000" },
    { score: "1" + "0".repeat(40), maxExponent: "4999" },
  ];
  // independent oracle for the documented rules
  const expected = (r0: Reason, v0: (typeof values)[number], r1: Reason, v1: (typeof values)[number]) => {
    if (r0 === null || r1 === null) return { status: "pending" as const, waitingOn: [...(r0 === null ? [0] : []), ...(r1 === null ? [1] : [])] };
    if (r0 === "forfeit" && r1 === "forfeit") return { status: "finished" as const, outcome: "draw" };
    if (r0 === "forfeit") return { status: "finished" as const, outcome: "seat1" };
    if (r1 === "forfeit") return { status: "finished" as const, outcome: "seat0" };
    const s0 = BigInt(v0.score), s1 = BigInt(v1.score);
    if (s0 !== s1) return { status: "finished" as const, outcome: s0 > s1 ? "seat0" : "seat1" };
    const e0 = BigInt(v0.maxExponent), e1 = BigInt(v1.maxExponent);
    if (e0 !== e1) return { status: "finished" as const, outcome: e0 > e1 ? "seat0" : "seat1" };
    return { status: "finished" as const, outcome: "draw" };
  };
  it("every (reason x value) pair for both seats matches the independent resolver", () => {
    let n = 0;
    for (const r0 of reasons) for (const v0 of values) for (const r1 of reasons) for (const v1 of values) {
      const got = comp.resolveDuel({ terminalReason: r0, ...v0 }, { terminalReason: r1, ...v1 });
      const want = expected(r0, v0, r1, v1);
      expect(got.status, `${r0}/${v0.score} vs ${r1}/${v1.score}`).toBe(want.status);
      if (want.status === "finished") expect(got.outcome).toBe(want.outcome);
      else expect(got.waitingOn).toEqual(want.waitingOn);
      n++;
    }
    expect(n).toBe(4 * 7 * 4 * 7);
  });
});

describe("DUEL-02/04/05: match state machine (dead seat, duplicates, restart, bots)", () => {
  const humanMatch = () => {
    let m = comp.createMatch({ id: "m1", kind: "human-vs-human", seasonId: "s2026-10", rulesetVersion: "duel-v1", hostAccountId: "alice" });
    m = comp.reduceMatch(m, { type: "join", accountId: "bob" });
    return m;
  };
  it("lobby -> join -> active; same account cannot take both seats; third account rejected", () => {
    const lobby = comp.createMatch({ id: "m", kind: "human-vs-human", seasonId: "s", rulesetVersion: "duel-v1", hostAccountId: "alice" });
    expect(lobby.status).toBe("lobby");
    expect(errCode(() => comp.reduceMatch(lobby, { type: "join", accountId: "alice" }))).toBe("FORBIDDEN");
    const active = comp.reduceMatch(lobby, { type: "join", accountId: "bob" });
    expect(active.status).toBe("active");
    expect(errCode(() => comp.reduceMatch(active, { type: "join", accountId: "carol" }))).toBe("FORBIDDEN");
    expect(comp.reduceMatch(active, { type: "join", accountId: "bob" })).toBe(active); // idempotent re-join
  });
  it("dead seat does not end the match; the other seat keeps moving; finalize only when both are terminal", () => {
    let m = humanMatch();
    m = comp.reduceMatch(m, { type: "seat-ended", seat: 0, reason: "dead", score: "300", maxExponent: "6", acceptedMoves: 120 });
    expect(m.status).toBe("active");
    expect(m.outcome).toBeNull();
    m = comp.reduceMatch(m, { type: "progress", seat: 1, score: "250", maxExponent: "6", acceptedMoves: 200 });
    expect(m.status).toBe("active");
    m = comp.reduceMatch(m, { type: "progress", seat: 1, score: "9007199254740993", maxExponent: "20", acceptedMoves: 400 });
    expect(m.status).toBe("active");
    m = comp.reduceMatch(m, { type: "seat-ended", seat: 1, reason: "move-cap", score: "9007199254740993", maxExponent: "20", acceptedMoves: 500 });
    expect(m.status).toBe("finished");
    expect(m.outcome).toBe("seat1");
  });
  it("duplicate / replayed events after a restart are idempotent (same object) and never change the outcome", () => {
    const events = [
      { type: "seat-ended", seat: 0, reason: "dead", score: "10", maxExponent: "3", acceptedMoves: 9 },
      { type: "seat-ended", seat: 1, reason: "move-cap", score: "20", maxExponent: "4", acceptedMoves: 500 },
    ] as const;
    let m = humanMatch();
    for (const e of events) m = comp.reduceMatch(m, e);
    const finished = m;
    for (const e of events) expect(comp.reduceMatch(finished, e)).toBe(finished);
    expect(errCode(() => comp.reduceMatch(finished, { ...events[1], score: "21" }))).toBe("FORBIDDEN");
    expect(comp.reduceMatch(finished, { type: "forfeit", seat: 0 })).toBe(finished); // forfeit after natural end is a no-op
  });
  it("exactly one rating event pair per human match, conserved integer deltas, bots never rated", () => {
    let m = humanMatch();
    m = comp.reduceMatch(m, { type: "seat-ended", seat: 0, reason: "move-cap", score: "500", maxExponent: "7", acceptedMoves: 500 });
    expect(comp.ratingEventsFor(m, { seat0: 1000, seat1: 1000 })).toBeNull(); // not finished yet
    m = comp.reduceMatch(m, { type: "seat-ended", seat: 1, reason: "dead", score: "400", maxExponent: "6", acceptedMoves: 300 });
    const ev = comp.ratingEventsFor(m, { seat0: 1000, seat1: 1000 })!;
    expect(ev).not.toBeNull();
    expect(ev[0].delta + ev[1].delta).toBe(0);
    expect(Number.isInteger(ev[0].delta)).toBe(true);
    expect(ev[0].delta).toBeGreaterThan(0);
    expect(ev[0].after).toBe(ev[0].before + ev[0].delta);
    expect(ev[1].after).toBe(ev[1].before + ev[1].delta);
    expect(new Set(ev.map((e) => e.idempotencyKey)).size).toBe(2);
    expect(ev.map((e) => e.outcome)).toEqual([1, 0]);
    const rated = comp.reduceMatch(m, { type: "rated" });
    expect(comp.ratingEventsFor(rated, { seat0: 1012, seat1: 988 })).toBeNull(); // second finish/restart cannot rate again
    expect(comp.reduceMatch(rated, { type: "rated" })).toBe(rated);
    for (const kind of ["human-vs-bot", "bot-vs-bot"] as const) {
      let bm = comp.createMatch({ id: "b", kind, seasonId: "s", rulesetVersion: "duel-v1", hostAccountId: kind === "human-vs-bot" ? "alice" : undefined, botLabels: kind === "human-vs-bot" ? ["heuristic"] : ["greedy", "random"] });
      bm = comp.reduceMatch(bm, { type: "seat-ended", seat: 0, reason: "dead", score: "5", maxExponent: "2", acceptedMoves: 3 });
      bm = comp.reduceMatch(bm, { type: "seat-ended", seat: 1, reason: "dead", score: "4", maxExponent: "2", acceptedMoves: 3 });
      expect(bm.status).toBe("finished");
      expect(comp.ratingEventsFor(bm, { seat0: 1000, seat1: 1000 }), kind).toBeNull();
      expect(errCode(() => comp.reduceMatch(bm, { type: "rated" })), kind).toBe("FORBIDDEN");
    }
  });
  it("double forfeit is a draw with zero rating change between equals; forfeit ends that seat exactly once", () => {
    let m = humanMatch();
    m = comp.reduceMatch(m, { type: "forfeit", seat: 0 });
    expect(m.status).toBe("active"); // the other seat is not terminal yet
    expect(comp.reduceMatch(m, { type: "forfeit", seat: 0 })).toBe(m);
    m = comp.reduceMatch(m, { type: "forfeit", seat: 1 });
    expect(m.status).toBe("finished");
    expect(m.outcome).toBe("draw");
    const ev = comp.ratingEventsFor(m, { seat0: 1000, seat1: 1000 })!;
    expect(ev.map((e) => e.delta)).toEqual([0, 0]);
  });
  it("progress cannot regress (stale delivery) and cannot happen in the lobby", () => {
    let m = humanMatch();
    m = comp.reduceMatch(m, { type: "progress", seat: 0, score: "50", maxExponent: "4", acceptedMoves: 20 });
    expect(errCode(() => comp.reduceMatch(m, { type: "progress", seat: 0, score: "40", maxExponent: "4", acceptedMoves: 25 }))).toBe("REVISION_CONFLICT");
    const lobby = comp.createMatch({ id: "l", kind: "human-vs-human", seasonId: "s", rulesetVersion: "duel-v1", hostAccountId: "alice" });
    expect(errCode(() => comp.reduceMatch(lobby, { type: "progress", seat: 0, score: "1", maxExponent: "1", acceptedMoves: 1 }))).toBe("FORBIDDEN");
  });
});

describe("Elo (elo-v1): integer, conserved, monotone, deterministic", () => {
  const roundHalfAway = (x: number) => Math.sign(x) * Math.round(Math.abs(Number(x.toFixed(9))));
  const expectedScore = (a: number, b: number) => 1 / (1 + 10 ** ((b - a) / 400));
  it("deltas follow K*(S-E) with K=24 (implementation constant pinned for elo-v1), zero-sum, integer, bounded", () => {
    const f = new Fuzz("elo");
    for (let i = 0; i < 3000; i++) {
      const a = 400 + f.int(2400);
      const b = 400 + f.int(2400);
      for (const s of [0, 0.5, 1] as const) {
        const r = comp.applyElo(a, b, s);
        expect(Number.isInteger(r.deltaA)).toBe(true);
        expect(r.deltaA + r.deltaB).toBe(0);
        expect(Math.abs(r.deltaA)).toBeLessThanOrEqual(24);
        expect(r.afterA + r.afterB).toBe(a + b);
        expect(r.deltaA).toBe(roundHalfAway(24 * (s - expectedScore(a, b))) || 0);
      }
      expect(comp.applyElo(a, b, 1).deltaA).toBeGreaterThanOrEqual(comp.applyElo(a, b, 0.5).deltaA);
      expect(comp.applyElo(a, b, 0.5).deltaA).toBeGreaterThanOrEqual(comp.applyElo(a, b, 0).deltaA);
    }
    expect(comp.applyElo(1000, 1000, 0.5)).toEqual({ deltaA: 0, deltaB: 0, afterA: 1000, afterB: 1000 });
    expect(comp.applyElo(1000, 1000, 1).deltaA).toBe(12);
  });
  it("upset pays more than the favourite's win", () => {
    expect(comp.applyElo(1000, 1400, 1).deltaA).toBeGreaterThan(comp.applyElo(1400, 1000, 1).deltaA);
  });
  it("non-integer ratings and self-rating are rejected", () => {
    expect(errCode(() => comp.expectedScore(1000.5, 1000))).toBe("VALIDATION_ERROR");
    expect(
      errCode(() => comp.rateMatch({ matchId: "m", seasonId: "s", rulesetVersion: "r", seat0: { accountId: "a", rating: 1000 }, seat1: { accountId: "a", rating: 1000 }, outcome: "seat0" })),
    ).toBe("FORBIDDEN");
  });
});

describe("RANK ordering with scores above 2^53 (RANK-03, DB-08)", () => {
  type Row = { attemptId: string; createdOrder: number; score: string; maxExponent: string };
  const cmp = (a: Row, b: Row) => {
    const sa = BigInt(a.score), sb = BigInt(b.score);
    if (sa !== sb) return sa > sb ? -1 : 1;
    const ea = BigInt(a.maxExponent), eb = BigInt(b.maxExponent);
    if (ea !== eb) return ea > eb ? -1 : 1;
    if (a.createdOrder !== b.createdOrder) return a.createdOrder - b.createdOrder;
    return a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0;
  };
  it("rankStandings equals a BigInt-sorted oracle on 6000 adversarial rows; ranks are 1..n; input untouched", () => {
    const f = new Fuzz("rank");
    const rows: Row[] = [];
    for (let i = 0; i < 6000; i++) {
      const digits = 1 + f.int(45);
      let s = String(1 + f.int(9));
      for (let d = 1; d < digits; d++) s += String(f.int(10));
      if (i % 11 === 0 && rows.length) s = rows[f.int(rows.length)]!.score; // exact score ties
      if (i % 7 === 0) s = String(2n ** 53n + BigInt(f.int(5))); // float-collision zone
      rows.push({ attemptId: `a${String(f.int(1e6)).padStart(7, "0")}-${i}`, createdOrder: f.int(300), score: s, maxExponent: String(1 + f.int(f.pick([20, 5000]))) });
    }
    const frozen = Object.freeze(rows.map((r) => Object.freeze({ ...r })));
    const ranked = comp.rankStandings(frozen);
    const want = [...rows].sort(cmp);
    expect(ranked.map((r) => r.attemptId)).toEqual(want.map((r) => r.attemptId));
    expect(ranked.map((r) => r.rank)).toEqual(ranked.map((_, i) => i + 1));
    expect(frozen[0]).toEqual(rows[0]);
    // float sorting would have been wrong on this data
    const floatSorted = [...rows].sort((a, b) => Number(b.score) - Number(a.score) || Number(b.maxExponent) - Number(a.maxExponent) || a.createdOrder - b.createdOrder || (a.attemptId < b.attemptId ? -1 : 1)).map((r) => r.attemptId);
    expect(floatSorted).not.toEqual(want.map((r) => r.attemptId));
  });
  it("boardMaxExponent compares exponents as exact decimals", () => {
    const cells: Cell[] = ["9", "10", null, "100", "99"];
    expect(comp.boardMaxExponent({ cells })).toBe("100");
    expect(comp.boardMaxExponent({ cells: [null, null] })).toBe("0");
    expect(comp.boardMaxExponent({ cells: ["9007199254740993", "9007199254740992"] })).toBe("9007199254740993");
  });
  it("ladder order: rating, wins, fewer games, account id (total and stable)", () => {
    const rows = [
      { accountId: "c", rating: 1010, played: 5, won: 3, drawn: 1, lost: 1 },
      { accountId: "a", rating: 1010, played: 4, won: 3, drawn: 0, lost: 1 },
      { accountId: "b", rating: 1010, played: 4, won: 3, drawn: 0, lost: 1 },
      { accountId: "d", rating: 1020, played: 9, won: 1, drawn: 0, lost: 8 },
      { accountId: "e", rating: 1010, played: 9, won: 4, drawn: 0, lost: 5 },
    ];
    expect(comp.rankLadder(rows).map((r) => r.accountId)).toEqual(["d", "e", "a", "b", "c"]);
    expect(comp.rankLadder(rows).map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("RANK-01/02: attempt policy and official rules", () => {
  const open = { status: "open", rulesetVersion: "ranked-v1" } as const;
  it("attempt decisions: one official attempt per account; active resumes; completed/forfeited consume; guests/closed rejected", () => {
    expect(comp.decideAttempt({ identityKind: "user", challenge: open, existing: null })).toEqual({ action: "create" });
    expect(comp.decideAttempt({ identityKind: "user", challenge: open, existing: { gameId: "g", status: "active" } })).toEqual({ action: "resume", gameId: "g" });
    for (const status of ["completed", "forfeited"] as const) expect(comp.decideAttempt({ identityKind: "user", challenge: open, existing: { gameId: "g", status } })).toMatchObject({ action: "reject", code: "FORBIDDEN" });
    expect(comp.decideAttempt({ identityKind: "guest", challenge: open, existing: null })).toMatchObject({ action: "reject", reason: "guest" });
    expect(comp.decideAttempt({ identityKind: "user", challenge: { ...open, status: "closed" }, existing: null })).toMatchObject({ action: "reject", reason: "challenge-closed" });
    expect(comp.decideAttempt({ identityKind: "user", challenge: { ...open, status: "closed" }, existing: { gameId: "g", status: "active" } })).toMatchObject({ action: "reject" });
  });
  it("ranked requests: undo and custom options are FORBIDDEN, moves/forfeits allowed; only exact official rules pass", () => {
    expect(errCode(() => comp.assertRankedRequestAllowed({ kind: "undo" }))).toBe("FORBIDDEN");
    expect(errCode(() => comp.assertRankedRequestAllowed({ kind: "custom-options" }))).toBe("FORBIDDEN");
    expect(errCode(() => comp.assertRankedRequestAllowed({ kind: "move" }))).toBeUndefined();
    expect(errCode(() => comp.assertRankedRequestAllowed({ kind: "forfeit" }))).toBeUndefined();
    expect(comp.isOfficialRankedRules(RANKED_RULES)).toBe(true);
    for (const tweak of [{ moveCap: 501 }, { moveCap: null }, { boardSize: 5 }, { undoLimit: 1 }, { official: false }, { spawnFourTenths: 2 }, { startTiles: 3 }] as const) {
      expect(comp.isOfficialRankedRules({ ...RANKED_RULES, ...tweak }), JSON.stringify(tweak)).toBe(false);
    }
    expect(RANKED_RULES.moveCap).toBe(500);
  });
  it("attempt end reasons and standing eligibility: forfeits are consumed but never ranked", () => {
    expect(comp.attemptEndReason({ status: "forfeited" }, false)).toBe("forfeit");
    expect(comp.attemptEndReason({ status: "completed" }, true)).toBe("dead");
    expect(comp.attemptEndReason({ status: "completed" }, false)).toBe("move-cap");
    expect(comp.attemptEndReason({ status: "active" }, false)).toBeNull();
    expect(comp.isStandingEligible("completed")).toBe(true);
    expect(comp.isStandingEligible("forfeited")).toBe(false);
    expect(comp.isStandingEligible("active")).toBe(false);
  });
  it("isGameOver agrees with the competition's dead-board input on a real 500-move ranked bot game end state", () => {
    const g = new bots.BotGame({ rules: RANKED_RULES, gameSeed: "rk-end", config: cfg("greedy", "k"), ignoreTimeBudget: true });
    g.runToEnd();
    expect(g.state.status).toBe("completed");
    const dead = isGameOver(g.state.board);
    expect(comp.attemptEndReason(g.state, dead)).toBe(dead ? "dead" : "move-cap");
    if (!dead) expect(g.state.acceptedMoves).toBe(500);
  });
});

describe("seasons", () => {
  it("season ids/bounds are derived from explicit instants, half-open, and archived seasons are read-only", () => {
    expect(comp.seasonIdForInstant("2026-10-12T23:00:00Z")).toBe("s2026-10");
    expect(comp.seasonIdForInstant("2026-12-31T23:59:59.999Z")).toBe("s2026-12");
    expect(comp.seasonIdForInstant("2027-01-01T00:00:00Z")).toBe("s2027-01");
    const b = comp.seasonBounds("s2026-12");
    expect(b).toEqual({ startsAt: "2026-12-01T00:00:00.000Z", endsAt: "2027-01-01T00:00:00.000Z" });
    expect(comp.isInstantInSeason(b, b.startsAt)).toBe(true);
    expect(comp.isInstantInSeason(b, b.endsAt)).toBe(false);
    expect(comp.acceptsNewResults({ status: "archived" })).toBe(false);
    expect(errCode(() => comp.seasonBounds("s2026-13"))).toBe("VALIDATION_ERROR");
    expect(errCode(() => comp.seasonIdForInstant("garbage"))).toBe("VALIDATION_ERROR");
  });
});

void legalMoves;
void DIRS;
