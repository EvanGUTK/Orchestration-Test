/**
 * QUALITY-001 task (1): differential test of the real @2048/engine against the independent oracle in ./oracle/*.
 * The oracle was written from docs/CONTRACTS.md + CONTRACT-001 and never imports @2048/*. Everything here is
 * black-box through the engine's public API (the same exports bots/competition may use).
 * Covers ENG-01..ENG-10. Fuzz inputs are generated from a fixed seed, so failures reproduce exactly.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLASSIC_RULES,
  RANKED_RULES,
  customRules,
  type Direction,
  type DomainEvent,
  type GameState,
  type Ruleset,
} from "@2048/contracts";
import * as engine from "@2048/engine";
import { BOT_SEED_NAMESPACE, OracleRng, deriveWords } from "./oracle/prng.ts";
import {
  applyMove as oApply,
  canonical,
  checksum,
  isDead,
  legalMoves as oLegal,
  makeState,
  newGame as oNew,
  slide as oSlide,
  type Cell,
  type Dir,
  type ORules,
  type OState,
} from "./oracle/game.ts";

const DIRS: Dir[] = ["up", "right", "down", "left"];

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
const clone = <T>(o: T): T => structuredClone(o);

function toORules(r: Ruleset): ORules {
  return { version: r.version, boardSize: r.boardSize, moveCap: r.moveCap, startTiles: r.startTiles, spawnFourTenths: r.spawnFourTenths };
}
const asO = (s: GameState): OState => s as unknown as OState;

class Fuzz {
  rng: OracleRng;
  constructor(seed: string) {
    this.rng = new OracleRng(deriveWords(`fuzz:${seed}`));
  }
  int(n: number) {
    return this.rng.below(n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  /** Board with low exponents so merges/collisions are frequent; occasionally sparse or full. */
  board(size: number, maxExp = 5): Cell[] {
    const density = this.pick([0.15, 0.4, 0.7, 1]);
    const cells: Cell[] = [];
    for (let i = 0; i < size * size; i++) cells.push(this.int(1000) / 1000 < density ? String(1 + this.int(maxExp)) : null);
    return cells;
  }
}

describe("sha256Hex vs node:crypto (seed derivation depends on it)", () => {
  const f = new Fuzz("sha");
  const inputs: string[] = ["", "a", "abc", "héllo wörld ✓", "\u{1F600}", "\u0000", "2048-infinite/v1:"];
  for (const len of [54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65536]) inputs.push("x".repeat(len));
  for (let i = 0; i < 100; i++) inputs.push(Array.from({ length: f.int(300) }, () => String.fromCodePoint(32 + f.int(0x2fff))).join(""));
  it("matches for edge lengths and random unicode", () => {
    for (const s of inputs) expect(engine.sha256Hex(s), JSON.stringify(s.slice(0, 20))).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
  });
});

describe("PRNG + seed derivation vs oracle (ENG-10)", () => {
  const f = new Fuzz("prng");
  const seeds = ["", "0", "seed-1", "2048", "héllo wörld ✓", "golden-1", " ", "\n", "é", "é", "a".repeat(1000), ...Array.from({ length: 150 }, (_, i) => `s${i}-${f.int(1e9)}`)];
  it("deriveSeedWords equals the oracle for game and bot namespaces", () => {
    for (const s of seeds) {
      expect(engine.deriveSeedWords(s), JSON.stringify(s.slice(0, 20))).toEqual(deriveWords(s));
      expect(engine.deriveSeedWords(s, BOT_SEED_NAMESPACE)).toEqual(deriveWords(s, BOT_SEED_NAMESPACE));
    }
  });
  it("createRng next()/below(n)/state() equal the oracle for many n including rejection-heavy n", () => {
    const ns = [1, 2, 3, 5, 7, 10, 16, 100, 1000, 65536, 3_000_000_000, 2_147_483_649, 4_294_967_295, 2 ** 31, 2 ** 32 - 1];
    for (const seed of seeds.slice(0, 40)) {
      const words = deriveWords(seed);
      const a = engine.createRng(words);
      const b = new OracleRng(words);
      for (let i = 0; i < 60; i++) {
        if (i % 3 === 0) expect(a.next()).toBe(b.next());
        else {
          const n = ns[(i * 7 + seed.length) % ns.length]!;
          expect(a.below(n), `below(${n})`).toBe(b.below(n));
        }
      }
      expect(a.state().words).toEqual(b.words());
      expect(a.state().algorithm).toBe("xoshiro128ss-v1");
    }
  });
  it("engine rng matches the published reference prefix for [1,2,3,4]", () => {
    const r = engine.createRng([1, 2, 3, 4]);
    expect([r.next(), r.next(), r.next(), r.next()]).toEqual([11520, 0, 5927040, 70819200]);
  });
});

describe("slide vs oracle (ENG-01, ENG-02, ENG-08)", () => {
  it("public fixture vectors agree with the engine", () => {
    const fx = JSON.parse(readFileSync(new URL("../fixtures/slide-v1.json", import.meta.url), "utf8")) as {
      vectors: { id: string; size: number; direction: Dir; before: Cell[]; after: Cell[]; scoreDelta: string; changed: boolean }[];
    };
    for (const v of fx.vectors) {
      const r = engine.slide(deepFreeze({ size: v.size, cells: clone(v.before) }), v.direction);
      expect(r.board.cells, v.id).toEqual(v.after);
      expect(r.scoreDelta, v.id).toBe(v.scoreDelta);
      expect(r.changed, v.id).toBe(v.changed);
    }
  });

  it("4000 random boards (sizes 3..8, all directions): board, delta, changed, events equal the oracle; input frozen/untouched", () => {
    const f = new Fuzz("slide");
    for (let i = 0; i < 4000; i++) {
      const size = 3 + f.int(6);
      const cells = f.board(size, f.pick([2, 3, 6]));
      const dir = f.pick(DIRS);
      const input = deepFreeze({ size, cells: clone(cells) });
      const got = engine.slide(input, dir);
      const want = oSlide(cells, size, dir);
      const ctx = `#${i} ${size}x${size} ${dir} ${JSON.stringify(cells)}`;
      expect(got.board.cells, ctx).toEqual(want.cells);
      expect(got.board.size).toBe(size);
      expect(got.scoreDelta, ctx).toBe(want.scoreDelta.toString());
      expect(got.changed, ctx).toBe(want.changed);
      expect(got.events, ctx).toEqual(want.events);
      expect(input.cells, "input must be unchanged").toEqual(cells);
    }
  });

  it("mass conservation (sum of 2^e before == after) and rotation/transpose consistency", () => {
    const f = new Fuzz("mass");
    const mass = (cells: readonly Cell[]) => cells.reduce((a, c) => a + (c === null ? 0n : 1n << BigInt(c)), 0n);
    // rotate board 90 degrees clockwise: new[r][c] = old[size-1-c][r]
    const rotate = (cells: readonly Cell[], size: number): Cell[] => {
      const out: Cell[] = new Array(cells.length).fill(null);
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) out[r * size + c] = cells[(size - 1 - c) * size + r]!;
      return out;
    };
    const rotDir: Record<Dir, Dir> = { up: "right", right: "down", down: "left", left: "up" };
    for (let i = 0; i < 1500; i++) {
      const size = 3 + f.int(6);
      const cells = f.board(size, 4);
      const dir = f.pick(DIRS);
      const r = engine.slide({ size, cells }, dir);
      expect(mass(r.board.cells)).toBe(mass(cells));
      // sliding the rotated board in the rotated direction == rotating the slid board
      const r2 = engine.slide({ size, cells: rotate(cells, size) }, rotDir[dir]);
      expect(r2.board.cells).toEqual(rotate(r.board.cells, size));
      expect(r2.scoreDelta).toBe(r.scoreDelta);
    }
  });

  it("collisions: one merge per tile, merges happen toward the leading edge (ENG-02)", () => {
    const row = (xs: (string | null)[]) => engine.slide({ size: 4, cells: [...xs, ...new Array(12).fill(null)] }, "left").board.cells.slice(0, 4);
    expect(row(["1", "1", "1", "1"])).toEqual(["2", "2", null, null]);
    expect(row(["1", "1", "1", null])).toEqual(["2", "1", null, null]);
    expect(row([null, "1", "1", "1"])).toEqual(["2", "1", null, null]);
    expect(row(["2", "1", "1", "2"])).toEqual(["2", "2", "2", null]);
    expect(row(["1", "2", "1", "2"])).toEqual(["1", "2", "1", "2"]);
  });

  it("high values: exponents 54, 256, 4096 and scores > 2^53 stay exact decimal strings (ENG-05)", () => {
    for (const e of [53, 54, 255, 256, 1000, 4095, 4096]) {
      const cells: Cell[] = new Array(16).fill(null);
      cells[0] = String(e);
      cells[1] = String(e);
      const r = engine.slide({ size: 4, cells }, "left");
      expect(r.board.cells[0]).toBe(String(e + 1));
      expect(r.scoreDelta).toBe((1n << BigInt(e + 1)).toString());
      const m = r.events.find((x) => x.type === "merge") as Extract<DomainEvent, { type: "merge" }>;
      expect(m.value).toBe((1n << BigInt(e + 1)).toString());
      expect(m.exponent).toBe(String(e + 1));
    }
  });
});

describe("legalMoves / isGameOver vs oracle (ENG-07)", () => {
  it("random boards: stable order up,right,down,left; game over iff no legal move", () => {
    const f = new Fuzz("legal");
    for (let i = 0; i < 3000; i++) {
      const size = 3 + f.int(6);
      const cells = f.board(size, size > 4 ? 3 : 30);
      const b = deepFreeze({ size, cells });
      expect(engine.legalMoves(b)).toEqual(oLegal(cells, size));
      expect(engine.isGameOver(b)).toBe(isDead(cells, size));
      expect(engine.isGameOver(b)).toBe(!cells.includes(null) && oLegal(cells, size).length === 0);
    }
  });
  it("spec boards: full unequal is dead, full mergeable is active, empty is active", () => {
    const dead = ["1", "2", "1", "2", "2", "1", "2", "1", "1", "2", "1", "2", "2", "1", "2", "1"];
    expect(engine.isGameOver({ size: 4, cells: dead })).toBe(true);
    expect(engine.legalMoves({ size: 4, cells: dead })).toEqual([]);
    const live = dead.slice();
    live[15] = "2";
    expect(engine.isGameOver({ size: 4, cells: live })).toBe(false);
    // cell 15 == cell 14 (row) and == cell 11 (column): every direction merges something
    expect(engine.legalMoves({ size: 4, cells: live })).toEqual(oLegal(live, 4));
    expect(oLegal(live, 4).length).toBeGreaterThan(0);
    // an empty board has no legal move but is NOT game over (game over needs a full board)
    expect(engine.legalMoves({ size: 4, cells: new Array(16).fill(null) })).toEqual([]);
    expect(engine.isGameOver({ size: 4, cells: new Array(16).fill(null) })).toBe(false);
  });
});

describe("whole games: newGame/applyMove/serialize/stateChecksum vs oracle (ENG-03, ENG-04)", () => {
  const rulesets: Ruleset[] = [
    CLASSIC_RULES,
    RANKED_RULES,
    customRules({ boardSize: 3 }),
    customRules({ boardSize: 5, spawnFourTenths: 3 }),
    customRules({ boardSize: 6, spawnFourTenths: 0 }),
    customRules({ boardSize: 8, spawnFourTenths: 10, startTiles: 5 }),
    customRules({ boardSize: 4, moveCap: 40 }),
    customRules({ boardSize: 7, startTiles: 1 }),
  ];

  for (const rules of rulesets) {
    it(`${rules.version}: 12 seeds x up to 400 moves incl. no-ops are byte-identical to the oracle`, () => {
      const f = new Fuzz(`game:${rules.version}`);
      const orules = toORules(rules);
      for (let g = 0; g < 12; g++) {
        const seed = `q-${rules.version}-${g}`;
        let st: GameState = engine.newGame(rules, seed);
        let ost = oNew(orules, seed).state;
        expect(engine.serialize(st), `${seed} initial`).toBe(canonical(ost));
        expect(engine.stateChecksum(st)).toBe(checksum(ost));
        for (let m = 0; m < 400 && ost.status === "active"; m++) {
          const dir = f.pick(DIRS);
          deepFreeze(st);
          const before = engine.serialize(st);
          const got = engine.applyMove(st, dir, rules);
          const want = oApply(ost, dir, orules);
          const ctx = `${seed} move ${m} ${dir}`;
          expect(engine.serialize(st), `${ctx}: input mutated`).toBe(before);
          expect(got.changed, ctx).toBe(want.changed);
          expect(got.scoreDelta, ctx).toBe(want.scoreDelta.toString());
          if (!want.changed) {
            expect(got.state, `${ctx}: no-op must return the same state object`).toBe(st);
            expect(got.events, ctx).toEqual([]);
          }
          st = got.state;
          ost = want.state;
          expect(engine.serialize(st), ctx).toBe(canonical(ost));
          expect(got.events, ctx).toEqual(want.events);
          if (m % 25 === 0 || ost.status !== "active") expect(engine.stateChecksum(st), ctx).toBe(checksum(ost));
        }
        expect(st.status).toBe(ost.status);
      }
    });
  }

  it("serialize -> deserialize -> keep playing equals playing straight through (ENG-04)", () => {
    const rules = CLASSIC_RULES;
    const f = new Fuzz("reload");
    let a = engine.newGame(rules, "reload-1");
    let b = engine.newGame(rules, "reload-1");
    for (let i = 0; i < 150 && a.status === "active"; i++) {
      const d = f.pick(DIRS);
      a = engine.applyMove(a, d, rules).state;
      b = engine.applyMove(engine.deserialize(engine.serialize(b)), d, rules).state;
      expect(engine.serialize(b)).toBe(engine.serialize(a));
    }
    expect(engine.deserialize(engine.serialize(a))).toEqual(a);
  });

  it("ENG-03: no-op then changed move: counters, score, PRNG untouched by the no-op; the next move spawns once", () => {
    const rules = CLASSIC_RULES;
    // a board where only "left"/"right" are blocked: single tile in the top-left corner
    const cells: Cell[] = new Array(16).fill(null);
    cells[0] = "1";
    const st = engine.validateState(makeState(toORules(rules), cells, { words: [7, 8, 9, 10] }) as unknown as GameState);
    const noop = engine.applyMove(st, "up", rules);
    expect(noop.changed).toBe(false);
    expect(noop.state).toBe(st);
    const moved = engine.applyMove(st, "down", rules);
    expect(moved.changed).toBe(true);
    expect(moved.events.filter((e) => e.type === "spawn")).toHaveLength(1);
    expect(moved.state.revision).toBe(st.revision + 1);
    expect(moved.state.acceptedMoves).toBe(st.acceptedMoves + 1);
    const o = oApply(asO(st), "down", toORules(rules));
    expect(engine.serialize(moved.state)).toBe(canonical(o.state));
  });

  it("replay() reproduces per-move checksums and the final state; no-ops are reported unchanged", () => {
    const f = new Fuzz("replay");
    const rules = customRules({ boardSize: 6 });
    const moves: Direction[] = Array.from({ length: 300 }, () => f.pick(DIRS));
    const initial = engine.newGame(rules, "replay-seed");
    const out = engine.replay(initial, moves, rules);
    let o = oNew(toORules(rules), "replay-seed").state;
    let i = 0;
    for (const mv of moves) {
      if (o.status !== "active") break;
      const r = oApply(o, mv, toORules(rules));
      o = r.state;
      expect(out.steps[i]!.direction).toBe(mv);
      expect(out.steps[i]!.changed).toBe(r.changed);
      expect(out.steps[i]!.checksum).toBe(checksum(o));
      i++;
    }
    expect(engine.serialize(out.state)).toBe(canonical(o));
  });

  it("golden games (packages/contracts/golden/games-v1.json) replay identically through the engine", () => {
    type G = { rulesetVersion: string; boardSize: number; seed: string; spawnFourTenths: number; moveCap: number | null; steps: { direction: Direction; checksum: string; changed: boolean }[]; initial: { checksum: string }; finalChecksum: string };
    const games = (JSON.parse(readFileSync(new URL("../../packages/contracts/golden/games-v1.json", import.meta.url), "utf8")) as { games: G[] }).games;
    for (const g of games) {
      const rules =
        g.rulesetVersion === "classic-v1" ? CLASSIC_RULES : g.rulesetVersion === "ranked-v1" ? RANKED_RULES : customRules({ boardSize: g.boardSize, spawnFourTenths: g.spawnFourTenths, moveCap: g.moveCap });
      let st = engine.newGame(rules, g.seed);
      expect(engine.stateChecksum(st)).toBe(g.initial.checksum);
      for (const s of g.steps) {
        const r = engine.applyMove(st, s.direction, rules);
        expect(r.changed).toBe(s.changed);
        st = r.state;
        expect(engine.stateChecksum(st)).toBe(s.checksum);
      }
      expect(engine.stateChecksum(st)).toBe(g.finalChecksum);
    }
  });
});

describe("status, move cap, 2048 and beyond (ENG-06, ENG-07)", () => {
  it("move cap completes the game on the capped move (event move-cap) and further moves throw FORBIDDEN", () => {
    const rules = customRules({ boardSize: 5, moveCap: 12 });
    const f = new Fuzz("cap");
    let st = engine.newGame(rules, "cap-seed");
    let last: ReturnType<typeof engine.applyMove> | null = null;
    while (st.status === "active") {
      last = engine.applyMove(st, f.pick(DIRS), rules);
      st = last.state;
    }
    expect(st.acceptedMoves).toBe(12);
    expect(last!.events.at(-1)).toEqual(isDead(st.board.cells as Cell[], 5) ? { type: "game-over" } : { type: "move-cap" });
    expect(() => engine.applyMove(st, "left", rules)).toThrowError(expect.objectContaining({ name: "DomainError", code: "FORBIDDEN" }) as never);
  });

  it("dead board completes the game; a full mergeable board stays active", () => {
    const rules = customRules({ boardSize: 3 });
    // 3x3, 8 filled in a no-merge pattern, one empty cell that the only legal move fills with a non-matching spawn
    const f = new Fuzz("dead");
    let ended = 0;
    for (let g = 0; g < 40; g++) {
      let st = engine.newGame(rules, `dead-${g}`);
      let o = oNew(toORules(rules), `dead-${g}`).state;
      for (let m = 0; m < 300 && st.status === "active"; m++) {
        const d = f.pick(DIRS);
        st = engine.applyMove(st, d, rules).state;
        o = oApply(o, d, toORules(rules)).state;
      }
      expect(st.status).toBe(o.status);
      if (st.status === "completed") {
        ended++;
        expect(engine.isGameOver(st.board)).toBe(true);
        expect(() => engine.applyMove(st, "up", rules)).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }) as never);
      }
    }
    expect(ended).toBeGreaterThan(0);
  });

  it("reaching 2048 (exponent 11): exactly one milestone, celebrated2048 flips once, game stays active and can continue to 4096", () => {
    const rules = CLASSIC_RULES;
    const orules = toORules(rules);
    const cells: Cell[] = new Array(16).fill(null);
    cells[0] = "10";
    cells[1] = "10";
    cells[4] = "2";
    const st = engine.validateState(makeState(orules, cells) as unknown as GameState);
    const o = asO(st);
    const r1 = engine.applyMove(st, "left", rules);
    const w1 = oApply(o, "left", orules);
    expect(r1.events.filter((e) => e.type === "milestone")).toEqual([{ type: "milestone", exponent: "11" }]);
    expect(r1.state.celebrated2048).toBe(true);
    expect(r1.state.status).toBe("active");
    expect(engine.serialize(r1.state)).toBe(canonical(w1.state));
    // second 2048 tile later must not celebrate again; reaching 4096 emits milestone 12 only
    const cells2: Cell[] = new Array(16).fill(null);
    cells2[0] = "11";
    cells2[1] = "11";
    const s2 = engine.validateState(makeState(orules, cells2, { celebrated2048: true }) as unknown as GameState);
    const r2 = engine.applyMove(s2, "left", rules);
    expect(r2.events.filter((e) => e.type === "milestone")).toEqual([{ type: "milestone", exponent: "12" }]);
    expect(r2.state.celebrated2048).toBe(true);
    expect(engine.serialize(r2.state)).toBe(canonical(oApply(asO(s2), "left", orules).state));
    // jumping several exponents at once is impossible by slide alone (+1 per merge); milestones ascend one per merge
    const cells3: Cell[] = new Array(16).fill(null);
    cells3[0] = "11";
    cells3[1] = "11";
    cells3[2] = "12";
    cells3[3] = "12"; // merges to 12 and 13 in one move -> milestones 12? max before=12, after=13 => only 13
    const s3 = engine.validateState(makeState(orules, cells3, { celebrated2048: true }) as unknown as GameState);
    const r3 = engine.applyMove(s3, "left", rules);
    expect(r3.events.filter((e) => e.type === "milestone")).toEqual(oApply(asO(s3), "left", orules).events.filter((e) => e.type === "milestone"));
  });

  it("spawn with exactly one empty cell still consumes position draw + value draw (below(1) consumes a draw)", () => {
    const rules = customRules({ boardSize: 3 });
    const orules = toORules(rules);
    // 8 tiles that cannot merge, move 'left' compresses one gap leaving exactly one empty cell afterwards
    const cells: Cell[] = ["1", "2", "1", "2", "1", "2", null, "2", "1"].map((c) => c) as Cell[];
    const st = engine.validateState(makeState(orules, cells, { words: [11, 22, 33, 44] }) as unknown as GameState);
    for (const d of DIRS) {
      const o = oApply(asO(st), d, orules);
      if (!o.changed) continue;
      expect(o.spawn!.emptyCount, "scenario must have a single empty cell at spawn time").toBe(1);
      const g = engine.applyMove(st, d, rules);
      expect(engine.serialize(g.state)).toBe(canonical(o.state));
    }
  });

  it("score beyond 2^53 and exponents in the thousands survive apply/serialize/deserialize (ENG-05)", () => {
    const rules = CLASSIC_RULES;
    const orules = toORules(rules);
    const cells: Cell[] = new Array(16).fill(null);
    cells[0] = "4096";
    cells[1] = "4096";
    const bigScore = (3n ** 120n).toString();
    const st = engine.validateState(makeState(orules, cells, { score: bigScore, celebrated2048: true }) as unknown as GameState);
    const r = engine.applyMove(st, "left", rules);
    expect(r.state.score).toBe((3n ** 120n + (1n << 4097n)).toString());
    expect(r.state.board.cells[0]).toBe("4097");
    const again = engine.deserialize(engine.serialize(r.state));
    expect(again).toEqual(r.state);
    expect(engine.serialize(r.state)).toBe(canonical(oApply(asO(st), "left", orules).state));
  });
});

describe("malformed state / resource pressure (ENG-09)", () => {
  const good = (): GameState => clone(engine.newGame(CLASSIC_RULES, "malformed"));
  type Mut = [string, (s: Record<string, unknown>) => void];
  const mutations: Mut[] = [
    ["schemaVersion 2", (s) => (s.schemaVersion = 2)],
    ["schemaVersion missing", (s) => delete s.schemaVersion],
    ["cells too short", (s) => ((s.board as { cells: unknown[] }).cells.length = 15)],
    ["size mismatch", (s) => ((s.board as { size: number }).size = 5)],
    ["size 2", (s) => (s.board = { size: 2, cells: [null, null, null, null] })],
    ["size 9", (s) => (s.board = { size: 9, cells: new Array(81).fill(null) })],
    ["numeric cell", (s) => ((s.board as { cells: unknown[] }).cells[0] = 2)],
    ["zero exponent", (s) => ((s.board as { cells: unknown[] }).cells[0] = "0")],
    ["leading zero exponent", (s) => ((s.board as { cells: unknown[] }).cells[0] = "01")],
    ["negative exponent", (s) => ((s.board as { cells: unknown[] }).cells[0] = "-1")],
    ["fractional exponent", (s) => ((s.board as { cells: unknown[] }).cells[0] = "1.5")],
    ["hex exponent", (s) => ((s.board as { cells: unknown[] }).cells[0] = "0x10")],
    ["exponent with whitespace", (s) => ((s.board as { cells: unknown[] }).cells[0] = " 3")],
    ["empty-string cell", (s) => ((s.board as { cells: unknown[] }).cells[0] = "")],
    ["score negative", (s) => (s.score = "-1")],
    ["score leading zero", (s) => (s.score = "007")],
    ["score number", (s) => (s.score = 5)],
    ["score exponent notation", (s) => (s.score = "1e9")],
    ["rng all zero", (s) => ((s.rng as { words: number[] }).words = [0, 0, 0, 0])],
    ["rng word too big", (s) => ((s.rng as { words: number[] }).words = [2 ** 32, 1, 2, 3])],
    ["rng word negative", (s) => ((s.rng as { words: number[] }).words = [-1, 1, 2, 3])],
    ["rng word fractional", (s) => ((s.rng as { words: number[] }).words = [1.5, 1, 2, 3])],
    ["rng 3 words", (s) => ((s.rng as { words: number[] }).words = [1, 2, 3])],
    ["rng algorithm", (s) => ((s.rng as { algorithm: string }).algorithm = "mt19937")],
    ["status unknown", (s) => (s.status = "paused")],
    ["acceptedMoves negative", (s) => (s.acceptedMoves = -1)],
    ["acceptedMoves float", (s) => (s.acceptedMoves = 1.5)],
    ["acceptedMoves unsafe", (s) => (s.acceptedMoves = 2 ** 60)],
    ["revision NaN", (s) => (s.revision = Number.NaN)],
    ["celebrated not boolean", (s) => (s.celebrated2048 = "yes")],
  ];
  for (const [name, mutate] of mutations) {
    it(`rejects: ${name} (typed DomainError, input not mutated)`, () => {
      const s = good() as unknown as Record<string, unknown>;
      mutate(s);
      const snapshot = JSON.stringify(s);
      let err: unknown;
      try {
        engine.validateState(deepFreeze(s));
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").toBeDefined();
      expect((err as { name: string }).name).toBe("DomainError");
      expect(["VALIDATION_ERROR", "RESOURCE_LIMIT"]).toContain((err as { code: string }).code);
      expect(JSON.stringify(s)).toBe(snapshot);
    });
  }

  it("deserialize rejects garbage JSON with a typed error", () => {
    for (const bad of ["", "{", "null", "[]", "42", '"x"', '{"schemaVersion":1}']) {
      let err: unknown;
      try {
        engine.deserialize(bad);
      } catch (e) {
        err = e;
      }
      expect((err as { name?: string })?.name, JSON.stringify(bad)).toBe("DomainError");
    }
  });

  it("resource pressure: absurd exponent length is RESOURCE_LIMIT (not a hang or truncation)", () => {
    const s = good() as unknown as { board: { cells: unknown[] } };
    s.board.cells[0] = "9".repeat(5000);
    const t0 = Date.now();
    let err: unknown;
    try {
      engine.validateState(s);
    } catch (e) {
      err = e;
    }
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((err as { code?: string }).code).toBe("RESOURCE_LIMIT");
  });

  it("unknown direction is a typed rejection, not a silent no-op or crash", () => {
    const st = engine.newGame(CLASSIC_RULES, "dir");
    let err: unknown;
    try {
      engine.applyMove(st, "sideways" as Direction, CLASSIC_RULES);
    } catch (e) {
      err = e;
    }
    expect((err as { name?: string })?.name).toBe("DomainError");
  });
});
