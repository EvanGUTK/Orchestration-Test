#!/usr/bin/env node
// CONTRACT-001 reference generator for golden vectors (chief-owned, independent of packages/engine).
// Uses node:crypto SHA-256 and BigInt. `--check` regenerates in memory and compares to the committed JSON.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NS = "2048-infinite/v1";
const BOT_NS = "2048-infinite/v1/bot";
const ENGINE_VERSION = "engine-1.0.0";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest();

export function deriveWords(seed, ns = NS) {
  const d = sha256(`${ns}:${seed}`);
  const w = [0, 1, 2, 3].map((i) => d.readUInt32LE(i * 4));
  return w.every((x) => x === 0) ? [1, 0, 0, 0] : w;
}

const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
export function next(words) {
  const [s0, s1, s2, s3] = words;
  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  let a = s0, b = s1, c = s2, d = s3;
  c = (c ^ a) >>> 0;
  d = (d ^ b) >>> 0;
  b = (b ^ c) >>> 0;
  a = (a ^ d) >>> 0;
  c = (c ^ t) >>> 0;
  d = rotl(d, 11);
  return { result, words: [a, b, c, d] };
}

// Unbiased rejection sampling: limit = 2^32 - (2^32 mod n); redraw while x >= limit; return x mod n.
export function below(words, n) {
  const limit = 4294967296 - (4294967296 % n);
  let w = words;
  for (;;) {
    const r = next(w);
    w = r.words;
    if (r.result < limit) return { value: r.result % n, words: w, draws: undefined };
  }
}

function spawn(board, words, fourTenths) {
  const empties = [];
  board.forEach((c, i) => c === null && empties.push(i));
  let r = below(words, empties.length);
  const index = empties[r.value];
  r = below(r.words, 10);
  const exponent = r.value < fourTenths ? "2" : "1";
  const cells = board.slice();
  cells[index] = exponent;
  return { cells, words: r.words, index, exponent };
}

function canonical(s) {
  const cells = s.cells.map((c) => (c === null ? "null" : JSON.stringify(c))).join(",");
  return (
    `{"schemaVersion":1,"engineVersion":${JSON.stringify(ENGINE_VERSION)},` +
    `"rulesetVersion":${JSON.stringify(s.rulesetVersion)},"board":{"size":${s.size},"cells":[${cells}]},` +
    `"score":${JSON.stringify(s.score)},"acceptedMoves":${s.acceptedMoves},"revision":${s.revision},` +
    `"rng":{"algorithm":"xoshiro128ss-v1","words":[${s.words.join(",")}]},` +
    `"status":${JSON.stringify(s.status)},"celebrated2048":${s.celebrated}}`
  );
}
const checksum = (s) => sha256(canonical(s)).toString("hex");

function lines(size, dir) {
  const out = [];
  for (let a = 0; a < size; a++) {
    const line = [];
    for (let b = 0; b < size; b++) {
      const [r, c] = dir === "left" ? [a, b] : dir === "right" ? [a, size - 1 - b]
        : dir === "up" ? [b, a] : [size - 1 - b, a];
      line.push(r * size + c);
    }
    out.push(line);
  }
  return out;
}

function slide(cells, size, dir) {
  const next = new Array(cells.length).fill(null);
  let delta = 0n;
  for (const idx of lines(size, dir)) {
    const tiles = idx.map((i) => cells[i]).filter((c) => c !== null);
    const out = [];
    for (let i = 0; i < tiles.length; i++) {
      if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
        const e = (BigInt(tiles[i]) + 1n).toString();
        out.push(e);
        delta += 1n << BigInt(e);
        i++;
      } else out.push(tiles[i]);
    }
    out.forEach((e, k) => (next[idx[k]] = e));
  }
  const changed = next.some((c, i) => c !== cells[i]);
  return { cells: next, delta: delta.toString(), changed };
}

function isDead(cells, size) {
  if (cells.includes(null)) return false;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const v = cells[r * size + c];
    if (c + 1 < size && cells[r * size + c + 1] === v) return false;
    if (r + 1 < size && cells[(r + 1) * size + c] === v) return false;
  }
  return true;
}

function newGame(rules, seed) {
  let words = deriveWords(seed);
  let cells = new Array(rules.size * rules.size).fill(null);
  const spawns = [];
  for (let i = 0; i < rules.startTiles; i++) {
    const s = spawn(cells, words, rules.fourTenths);
    cells = s.cells; words = s.words; spawns.push({ index: s.index, exponent: s.exponent });
  }
  return { rulesetVersion: rules.version, size: rules.size, cells, score: "0", acceptedMoves: 0,
    revision: 0, words, status: "active", celebrated: false, spawns };
}

function apply(state, dir, rules) {
  const s = slide(state.cells, state.size, dir);
  if (!s.changed) return { state, changed: false, scoreDelta: "0" };
  const sp = spawn(s.cells, state.words, rules.fourTenths);
  const acceptedMoves = state.acceptedMoves + 1;
  const maxE = Math.max(...sp.cells.filter(Boolean).map(Number));
  const prevMax = Math.max(0, ...state.cells.filter(Boolean).map(Number));
  const celebrated = state.celebrated || (prevMax < 11 && maxE >= 11);
  let status = "active";
  if (isDead(sp.cells, state.size) || (rules.moveCap !== null && acceptedMoves >= rules.moveCap)) status = "completed";
  return {
    state: { ...state, cells: sp.cells, score: (BigInt(state.score) + BigInt(s.delta)).toString(),
      acceptedMoves, revision: state.revision + 1, words: sp.words, status, celebrated },
    changed: true, scoreDelta: s.delta,
  };
}

const CLASSIC = { version: "classic-v1", size: 4, fourTenths: 1, startTiles: 2, moveCap: null };
const CUSTOM5 = { version: "custom-v1:5:3:2:none", size: 5, fourTenths: 3, startTiles: 2, moveCap: null };
const RANKED = { version: "ranked-v1", size: 4, fourTenths: 1, startTiles: 2, moveCap: 500 };

export function build() {
  const seeds = ["", "0", "seed-1", "2048", "héllo wörld ✓", "golden-1"];
  const prng = {
    schemaVersion: 1,
    algorithm: "xoshiro128ss-v1",
    seedDerivation: `SHA-256(UTF-8("${NS}:" + seed)); first 16 bytes as 4 little-endian uint32; [1,0,0,0] if all zero`,
    botSeedDerivation: `same with namespace "${BOT_NS}"`,
    stepFunction: "r=rotl(s1*5,7)*9; t=s1<<9; s2^=s0; s3^=s1; s1^=s2; s0^=s3; s2^=t; s3=rotl(s3,11); all mod 2^32",
    boundedDraw: "limit=2^32-(2^32 mod n); loop x=next(); until x<limit; return x mod n",
    raw: [
      { seed: "", initialWordsFromFixedState: [1, 2, 3, 4] },
    ].map(() => {
      let w = [1, 2, 3, 4];
      const outputs = [];
      for (let i = 0; i < 16; i++) { const r = next(w); outputs.push(r.result); w = r.words; }
      return { initialWords: [1, 2, 3, 4], outputs, finalWords: w };
    })[0],
    seeds: seeds.map((seed) => {
      let w = deriveWords(seed);
      const words = w.slice();
      const outputs = [];
      for (let i = 0; i < 8; i++) { const r = next(w); outputs.push(r.result); w = r.words; }
      return { seed, words, outputs, finalWords: w, botWords: deriveWords(seed, BOT_NS) };
    }),
    bounded: [10, 16, 7, 3000000000].map((n) => {
      let w = deriveWords("golden-1");
      const values = [];
      for (let i = 0; i < 12; i++) { const r = below(w, n); values.push(r.value); w = r.words; }
      return { seed: "golden-1", n, values, finalWords: w };
    }),
  };

  const games = [];
  const dirs = ["left", "up", "right", "down", "left", "left", "up", "up", "right", "down"];
  for (const [rules, seed, count] of [[CLASSIC, "golden-1", 80], [CLASSIC, "2048", 60], [CUSTOM5, "golden-1", 60], [RANKED, "ranked-seed", 60]]) {
    let st = newGame(rules, seed);
    const initial = { cells: st.cells, rngWords: st.words, spawns: st.spawns, checksum: checksum(st) };
    const steps = [];
    for (let i = 0; i < count; i++) {
      const dir = dirs[(i * 7 + (i >> 2)) % dirs.length];
      const r = apply(st, dir, rules);
      steps.push({ direction: dir, changed: r.changed, scoreDelta: r.scoreDelta,
        revision: r.state.revision, acceptedMoves: r.state.acceptedMoves, score: r.state.score,
        status: r.state.status, rngWords: r.state.words, checksum: checksum(r.state) });
      st = r.state;
      if (st.status !== "active") break;
    }
    games.push({ rulesetVersion: rules.version, boardSize: rules.size, spawnFourTenths: rules.fourTenths,
      moveCap: rules.moveCap, seed, initial, steps, finalChecksum: checksum(st) });
  }
  return { prng, games: { schemaVersion: 1, engineVersion: ENGINE_VERSION, checksumVersion: 1, games } };
}

const json = (v) => JSON.stringify(v, null, 1) + "\n";
const files = { "prng-v1.json": (b) => json(b.prng), "games-v1.json": (b) => json(b.games) };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = build();
  const check = process.argv.includes("--check");
  let bad = false;
  for (const [name, fmt] of Object.entries(files)) {
    const path = join(HERE, name);
    const text = fmt(built);
    if (check) {
      if (readFileSync(path, "utf8") !== text) { console.error(`MISMATCH ${name}`); bad = true; }
      else console.log(`ok ${name}`);
    } else { writeFileSync(path, text); console.log(`wrote ${name}`); }
  }
  process.exit(bad ? 1 : 0);
}
