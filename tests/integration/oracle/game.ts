/**
 * INDEPENDENT oracle for slide / spawn / game-over / canonical state JSON,
 * written from docs/CONTRACTS.md and CONTRACT-001.md. No @2048/* imports.
 */
import { createHash } from "node:crypto";
import { OracleRng, deriveWords, type Words } from "./prng.ts";

export type Dir = "up" | "right" | "down" | "left";
export type Cell = string | null;
export type OState = {
  schemaVersion: 1;
  engineVersion: string;
  rulesetVersion: string;
  board: { size: number; cells: Cell[] };
  score: string;
  acceptedMoves: number;
  revision: number;
  rng: { algorithm: "xoshiro128ss-v1"; words: Words };
  status: "active" | "completed" | "forfeited";
  celebrated2048: boolean;
};
export type ORules = {
  version: string;
  boardSize: number;
  moveCap: number | null;
  startTiles: number;
  spawnFourTenths: number;
};

export const ENGINE_VERSION = "engine-1.0.0";
export const CLASSIC: ORules = { version: "classic-v1", boardSize: 4, moveCap: null, startTiles: 2, spawnFourTenths: 1 };
export const RANKED: ORules = { version: "ranked-v1", boardSize: 4, moveCap: 500, startTiles: 2, spawnFourTenths: 1 };

/** Cell indexes of each line, leading edge (the side tiles slide toward) first. */
export function lines(size: number, dir: Dir): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < size; a++) {
    const line: number[] = [];
    for (let b = 0; b < size; b++) {
      if (dir === "left") line.push(a * size + b);
      else if (dir === "right") line.push(a * size + (size - 1 - b));
      else if (dir === "up") line.push(b * size + a);
      else line.push((size - 1 - b) * size + a);
    }
    out.push(line);
  }
  return out;
}

export type SlideOut = { cells: Cell[]; changed: boolean; scoreDelta: bigint };

export function slide(cells: readonly Cell[], size: number, dir: Dir): SlideOut {
  const next: Cell[] = new Array(cells.length).fill(null);
  let delta = 0n;
  for (const line of lines(size, dir)) {
    const tiles = line.map((i) => cells[i]!).filter((c): c is string => c !== null).map((c) => BigInt(c));
    const merged: bigint[] = [];
    for (let k = 0; k < tiles.length; k++) {
      if (k + 1 < tiles.length && tiles[k] === tiles[k + 1]) {
        const e = tiles[k]! + 1n;
        merged.push(e);
        delta += 1n << e;
        k++;
      } else merged.push(tiles[k]!);
    }
    merged.forEach((e, p) => {
      next[line[p]!] = e.toString();
    });
  }
  const changed = next.some((c, i) => c !== cells[i]);
  return { cells: next, changed, scoreDelta: delta };
}

export function isDead(cells: readonly Cell[], size: number): boolean {
  if (cells.some((c) => c === null)) return false;
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      const v = cells[r * size + c];
      if (c + 1 < size && cells[r * size + c + 1] === v) return false;
      if (r + 1 < size && cells[(r + 1) * size + c] === v) return false;
    }
  return true;
}

export function legalMoves(cells: readonly Cell[], size: number): Dir[] {
  return (["up", "right", "down", "left"] as Dir[]).filter((d) => slide(cells, size, d).changed);
}

export type Spawn = { index: number; exponent: string; emptyCount: number };

/** One spawn: position draw over row-major empties, then value draw in [0,10). */
export function spawn(cells: Cell[], rng: OracleRng, spawnFourTenths: number): Spawn {
  const empties: number[] = [];
  cells.forEach((c, i) => {
    if (c === null) empties.push(i);
  });
  if (empties.length === 0) throw new Error("no empty cell");
  const index = empties[rng.below(empties.length)]!;
  const exponent = rng.below(10) < spawnFourTenths ? "2" : "1";
  cells[index] = exponent;
  return { index, exponent, emptyCount: empties.length };
}

export function newGame(rules: ORules, seed: string, seedNamespace?: string): { state: OState; spawns: Spawn[]; rng: OracleRng } {
  const rng = new OracleRng(deriveWords(seed, seedNamespace));
  const cells: Cell[] = new Array(rules.boardSize * rules.boardSize).fill(null);
  const spawns: Spawn[] = [];
  for (let i = 0; i < rules.startTiles; i++) spawns.push(spawn(cells, rng, rules.spawnFourTenths));
  const state = stamp(rules, cells, "0", 0, 0, rng, false);
  return { state, spawns, rng };
}

function maxExponent(cells: readonly Cell[]): bigint {
  let m = 0n;
  for (const c of cells) if (c !== null && BigInt(c) > m) m = BigInt(c);
  return m;
}

function stamp(rules: ORules, cells: Cell[], score: string, moves: number, revision: number, rng: OracleRng, celebrated: boolean): OState {
  const completed = isDead(cells, rules.boardSize) || (rules.moveCap !== null && moves >= rules.moveCap);
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    rulesetVersion: rules.version,
    board: { size: rules.boardSize, cells },
    score,
    acceptedMoves: moves,
    revision,
    rng: { algorithm: "xoshiro128ss-v1", words: rng.words() },
    status: completed ? "completed" : "active",
    celebrated2048: celebrated,
  };
}

export type OMove = { state: OState; changed: boolean; scoreDelta: bigint; spawn: Spawn | null };

/** The oracle never mutates `state`; it rebuilds an rng from the stored words. */
export function applyMove(state: OState, dir: Dir, rules: ORules): OMove {
  if (state.status !== "active") throw new Error("move on non-active state");
  const s = slide(state.board.cells, state.board.size, dir);
  if (!s.changed) return { state, changed: false, scoreDelta: 0n, spawn: null };
  const rng = new OracleRng(state.rng.words);
  const cells = s.cells.slice();
  const sp = spawn(cells, rng, rules.spawnFourTenths);
  const score = (BigInt(state.score) + s.scoreDelta).toString();
  const celebrated = state.celebrated2048 || maxExponent(cells) >= 11n;
  const next = stamp(rules, cells, score, state.acceptedMoves + 1, state.revision + 1, rng, celebrated);
  return { state: next, changed: true, scoreDelta: s.scoreDelta, spawn: sp };
}

/**
 * Canonical JSON: fixed key order (the GameState declaration order from docs/CONTRACTS.md),
 * no whitespace, row-major cells, decimal strings as strings, PRNG words as numbers.
 * Built by JSON.stringify over insertion-ordered literals (not string concatenation).
 */
export function canonical(state: OState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    engineVersion: state.engineVersion,
    rulesetVersion: state.rulesetVersion,
    board: { size: state.board.size, cells: state.board.cells },
    score: state.score,
    acceptedMoves: state.acceptedMoves,
    revision: state.revision,
    rng: { algorithm: state.rng.algorithm, words: state.rng.words },
    status: state.status,
    celebrated2048: state.celebrated2048,
  });
}

export function checksum(state: OState): string {
  return createHash("sha256").update(canonical(state), "utf8").digest("hex");
}
