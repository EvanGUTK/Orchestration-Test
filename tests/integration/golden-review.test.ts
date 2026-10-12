/**
 * QUALITY-001 / ENG-10: independent review of packages/contracts/golden/*.json.
 * The expected values come from an independently written oracle (tests/integration/oracle/*),
 * derived from docs/CONTRACTS.md + CONTRACT-001.md, NOT from golden/generate.mjs.
 * No @2048/* import: this test must stay green or red regardless of the engine implementation.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BOT_SEED_NAMESPACE, OracleRng, deriveWords } from "./oracle/prng.ts";
import {
  CLASSIC,
  RANKED,
  applyMove,
  canonical,
  checksum,
  isDead,
  newGame,
  slide,
  type Cell,
  type Dir,
  type ORules,
} from "./oracle/game.ts";


type W4 = number[];
type PrngSeed = { seed: string; words: W4; outputs: number[]; finalWords: W4; botWords: W4 };
type Bounded = { seed: string; n: number; values: number[]; finalWords: W4 };
type PrngGolden = {
  schemaVersion: number;
  algorithm: string;
  raw: { initialWords: W4; outputs: number[]; finalWords: W4 };
  seeds: PrngSeed[];
  bounded: Bounded[];
};
type GoldenStep = {
  direction: Dir; changed: boolean; scoreDelta: string; revision: number; acceptedMoves: number;
  score: string; status: string; rngWords: W4; checksum: string;
};
type GoldenGame = {
  rulesetVersion: string; boardSize: number; spawnFourTenths: number; moveCap: number | null; seed: string;
  initial: { cells: Cell[]; rngWords: W4; spawns: { index: number; exponent: string }[]; checksum: string };
  steps: GoldenStep[]; finalChecksum: string;
};
type GamesGolden = { schemaVersion: number; engineVersion: string; checksumVersion: number; games: GoldenGame[] };
type SlideVector = { id: string; size: number; direction: Dir; before: Cell[]; after: Cell[]; scoreDelta: string; changed: boolean };

const root = new URL("../../", import.meta.url);
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, root), "utf8")) as T;
const prng = read<PrngGolden>("packages/contracts/golden/prng-v1.json");
const games = read<GamesGolden>("packages/contracts/golden/games-v1.json");
const slideFixture = read<{ vectors: SlideVector[] }>("tests/fixtures/slide-v1.json");

const isU32 = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 0xffffffff;

describe("prng-v1.json (independent oracle)", () => {
  it("is well formed", () => {
    expect(prng.schemaVersion).toBe(1);
    expect(prng.algorithm).toBe("xoshiro128ss-v1");
    for (const w of [prng.raw.initialWords, prng.raw.finalWords]) expect(w.every(isU32)).toBe(true);
    for (const s of prng.seeds) {
      for (const w of [s.words, s.finalWords, s.botWords]) {
        expect(w).toHaveLength(4);
        expect(w.every(isU32)).toBe(true);
      }
      expect(s.outputs.every(isU32)).toBe(true);
    }
  });

  it("raw xoshiro128** stream from [1,2,3,4] matches (and matches the published reference prefix)", () => {
    // Prefix 11520, 0, 5927040, 70819200 is the well known reference output for state {1,2,3,4}.
    const rng = new OracleRng(prng.raw.initialWords);
    const out = prng.raw.outputs.map(() => rng.next());
    expect(out.slice(0, 4)).toEqual([11520, 0, 5927040, 70819200]);
    expect(out).toEqual(prng.raw.outputs);
    expect(rng.words()).toEqual(prng.raw.finalWords);
  });

  it("zero state is rejected", () => {
    expect(() => new OracleRng([0, 0, 0, 0])).toThrow();
  });

  for (const s of prng.seeds) {
    it(`seed ${JSON.stringify(s.seed)}: derivation, stream, bot namespace`, () => {
      expect(deriveWords(s.seed)).toEqual(s.words);
      const rng = new OracleRng(s.words);
      expect(s.outputs.map(() => rng.next())).toEqual(s.outputs);
      expect(rng.words()).toEqual(s.finalWords);
      expect(deriveWords(s.seed, BOT_SEED_NAMESPACE)).toEqual(s.botWords);
      // bot stream must differ from the game stream
      expect(s.botWords).not.toEqual(s.words);
    });
  }

  it("seed derivation is byte-exact UTF-8 (no normalization, no trimming)", () => {
    const direct = createHash("sha256").update(Buffer.from("2048-infinite/v1:héllo wörld ✓", "utf8")).digest();
    const w = deriveWords("héllo wörld ✓");
    expect(w[0]).toBe(direct.readUInt32LE(0));
    expect(w[3]).toBe(direct.readUInt32LE(12));
    // NFC vs NFD are different seeds
    expect(deriveWords("é")).not.toEqual(deriveWords("é"));
    expect(deriveWords(" a")).not.toEqual(deriveWords("a"));
  });

  for (const b of prng.bounded) {
    it(`bounded draw n=${b.n} seed=${b.seed}`, () => {
      const rng = new OracleRng(deriveWords(b.seed));
      expect(b.values.map(() => rng.below(b.n))).toEqual(b.values);
      expect(rng.words()).toEqual(b.finalWords);
    });
  }

  it("coverage: the bounded vectors actually exercise a rejected draw (otherwise rejection logic is unpinned)", () => {
    let rejected = 0;
    for (const b of prng.bounded) {
      const rng = new OracleRng(deriveWords(b.seed));
      for (let i = 0; i < b.values.length; i++) rng.below(b.n);
      rejected += rng.rejections;
    }
    // Reported to chief in the review: see result message. Failing here means "goldens do not pin rejection".
    expect(rejected).toBeGreaterThan(0);
  });

  it("rejection sampling: a rejected raw draw is discarded, never reduced mod n (n=3_000_000_000)", () => {
    const n = 3_000_000_000;
    const limit = 2 ** 32 - (2 ** 32 % n);
    expect(limit).toBe(3_000_000_000);
    const stream = new OracleRng([1, 2, 3, 4]);
    const raw = Array.from({ length: 400 }, () => stream.next());
    const i = raw.findIndex((x) => x >= limit);
    expect(i).toBeGreaterThanOrEqual(0);
    const pre = new OracleRng([1, 2, 3, 4]);
    for (let k = 0; k < i; k++) pre.next();
    const firstAccepted = raw.findIndex((x, k) => k >= i && x < limit);
    const v = pre.below(n);
    expect(v).toBe(raw[firstAccepted]! % n);
    expect(pre.rejections).toBe(firstAccepted - i);
    expect(pre.draws).toBe(i + (firstAccepted - i) + 1);
    // naive modulo of the rejected draw would differ
    expect(raw[i]! % n).not.toBe(v);
  });

  it("below(1) and powers of two consume exactly one draw and never reject", () => {
    for (const n of [1, 2, 4, 8, 16, 1024]) {
      const rng = new OracleRng([5, 6, 7, 8]);
      rng.below(n);
      expect(rng.draws).toBe(1);
      expect(rng.rejections).toBe(0);
    }
  });
});

describe("tests/fixtures/slide-v1.json (public vectors) against oracle", () => {
  for (const v of slideFixture.vectors) {
    it(`slide vector ${v.id}`, () => {
      const before: Cell[] = v.before;
      const copy = before.slice();
      const r = slide(before, v.size, v.direction as Dir);
      expect(before).toEqual(copy);
      expect(r.cells).toEqual(v.after);
      expect(r.scoreDelta.toString()).toBe(v.scoreDelta);
      expect(r.changed).toBe(v.changed);
    });
  }
});

describe("games-v1.json (independent oracle replays every game)", () => {
  const RULES: Record<string, ORules> = { "classic-v1": CLASSIC, "ranked-v1": RANKED };
  const rulesFor = (g: GoldenGame): ORules => {
    const base = RULES[g.rulesetVersion];
    if (base) return base;
    const m = /^custom-v1:(\d+):(\d+):(\d+):(none|\d+)$/.exec(g.rulesetVersion)!;
    return {
      version: g.rulesetVersion,
      boardSize: Number(m[1]),
      spawnFourTenths: Number(m[2]),
      startTiles: Number(m[3]),
      moveCap: m[4] === "none" ? null : Number(m[4]),
    };
  };

  it("header", () => {
    expect(games.schemaVersion).toBe(1);
    expect(games.engineVersion).toBe("engine-1.0.0");
    expect(games.checksumVersion).toBe(1);
    expect(games.games.length).toBeGreaterThanOrEqual(4);
  });

  (games.games).forEach((g, gi) => {
    it(`game #${gi} ${g.rulesetVersion} seed=${JSON.stringify(g.seed)}: initial state`, () => {
      const rules = rulesFor(g);
      expect(rules.boardSize).toBe(g.boardSize);
      expect(rules.spawnFourTenths).toBe(g.spawnFourTenths);
      expect(rules.moveCap).toBe(g.moveCap);
      const { state, spawns } = newGame(rules, g.seed);
      expect(state.board.cells).toEqual(g.initial.cells);
      expect(state.rng.words).toEqual(g.initial.rngWords);
      expect(spawns.map((s) => ({ index: s.index, exponent: s.exponent }))).toEqual(g.initial.spawns);
      expect(checksum(state)).toBe(g.initial.checksum);
    });

    it(`game #${gi} ${g.rulesetVersion} seed=${JSON.stringify(g.seed)}: every step`, () => {
      const rules = rulesFor(g);
      let { state } = newGame(rules, g.seed);
      g.steps.forEach((step, si: number) => {
        const before = canonical(state);
        const r = applyMove(state, step.direction, rules);
        const ctx = `game ${gi} step ${si} (${step.direction})`;
        expect(canonical(state), `${ctx}: oracle must not mutate`).toBe(before);
        expect(r.changed, ctx).toBe(step.changed);
        expect(r.scoreDelta.toString(), ctx).toBe(step.scoreDelta);
        state = r.state;
        expect(state.revision, ctx).toBe(step.revision);
        expect(state.acceptedMoves, ctx).toBe(step.acceptedMoves);
        expect(state.score, ctx).toBe(step.score);
        expect(state.status, ctx).toBe(step.status);
        expect(state.rng.words, ctx).toEqual(step.rngWords);
        expect(checksum(state), ctx).toBe(step.checksum);
      });
      expect(checksum(state)).toBe(g.finalChecksum);
    });
  });

  it("no-op steps are present and leave checksum untouched (ENG-03)", () => {
    let noops = 0;
    for (const g of games.games) {
      let prev = g.initial.checksum;
      for (const s of g.steps) {
        if (!s.changed) {
          noops++;
          expect(s.checksum).toBe(prev);
        }
        prev = s.checksum;
      }
    }
    expect(noops).toBeGreaterThan(0);
  });

  it("coverage census of the golden games (informational; asserts the minimum we rely on)", () => {
    const census = { changed: 0, noop: 0, emptyOneSpawn: 0, merges: 0, maxExp: 0, completed: 0, celebrated: 0, sizes: new Set<number>() };
    for (const g of games.games) {
      const rules = rulesFor(g);
      census.sizes.add(rules.boardSize);
      let { state } = newGame(rules, g.seed);
      for (const step of g.steps) {
        const r = applyMove(state, step.direction, rules);
        if (r.changed) {
          census.changed++;
          if (r.scoreDelta > 0n) census.merges++;
          if (r.spawn!.emptyCount === 1) census.emptyOneSpawn++;
        } else census.noop++;
        state = r.state;
        for (const c of state.board.cells) if (c !== null) census.maxExp = Math.max(census.maxExp, Number(c));
      }
      if (state.status !== "active") census.completed++;
      if (state.celebrated2048) census.celebrated++;
    }
    console.log("GOLDEN-CENSUS", JSON.stringify({ ...census, sizes: [...census.sizes] }));
    expect(census.merges).toBeGreaterThan(0);
  });

  it("final checksums are 64 lowercase hex chars", () => {
    for (const g of games.games) {
      expect(g.finalChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(g.initial.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("isDead agrees with the spec on spot boards (ENG-07)", () => {
    const checker = ["1", "2", "1", "2", "2", "1", "2", "1", "1", "2", "1", "2", "2", "1", "2", "1"];
    expect(isDead(checker, 4)).toBe(true); // full, no equal neighbours
    const horiz = checker.slice();
    horiz[14] = "1"; // 1,1 at row 3 cols 2-3? cell 15 is "1" -> mergeable horizontally
    expect(isDead(horiz, 4)).toBe(false);
    const vert = checker.slice();
    vert[11] = "1"; // cell 11 above cell 15 ("1")
    expect(isDead(vert, 4)).toBe(false);
    expect(isDead(["1", ...new Array(15).fill(null)], 4)).toBe(false); // empties => alive
  });
});
