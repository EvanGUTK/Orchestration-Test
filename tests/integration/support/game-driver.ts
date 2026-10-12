import { applyMove, canonical, legalMoves, newGame, type Dir, type ORules, type OState } from "../oracle/game.ts";

/** Rules the server must derive for a practice game created with {boardSize, spawnFourTenths} (see rules.ts customRules). */
export function practiceRules(boardSize: number, spawnFourTenths = 1): ORules {
  return { version: `custom-v1:${boardSize}:${spawnFourTenths}:2:none`, boardSize, spawnFourTenths, startTiles: 2, moveCap: null };
}

/** Preference order that survives tens of thousands of moves on 8x8 (measured: >26k moves with the oracle). */
const PREFERENCE: Dir[] = ["down", "left", "right", "up"];

export class OracleGame {
  state: OState;
  readonly rules: ORules;
  readonly moves: Dir[] = [];
  constructor(rules: ORules, seed: string) {
    this.rules = rules;
    this.state = newGame(rules, seed).state;
  }
  nextDirection(): Dir | null {
    const legal = legalMoves(this.state.board.cells, this.state.board.size);
    return PREFERENCE.find((d) => legal.includes(d)) ?? null;
  }
  illegalDirection(): Dir | null {
    const legal = legalMoves(this.state.board.cells, this.state.board.size);
    return (["up", "right", "down", "left"] as Dir[]).find((d) => !legal.includes(d)) ?? null;
  }
  apply(dir: Dir) {
    const r = applyMove(this.state, dir, this.rules);
    if (r.changed) this.moves.push(dir);
    this.state = r.state;
    return r;
  }
  canonical(): string {
    return canonical(this.state);
  }
}

/** Normalise a server GameState (or GameView.state) to the oracle's canonical JSON. */
export function canonicalOfServerState(s: OState): string {
  return canonical({
    schemaVersion: s.schemaVersion,
    engineVersion: s.engineVersion,
    rulesetVersion: s.rulesetVersion,
    board: { size: s.board.size, cells: [...s.board.cells] },
    score: s.score,
    acceptedMoves: s.acceptedMoves,
    revision: s.revision,
    rng: { algorithm: s.rng.algorithm, words: [...s.rng.words] as OState["rng"]["words"] },
    status: s.status,
    celebrated2048: s.celebrated2048,
  });
}

export function unwrapGame<T extends { id?: string; state?: unknown }>(body: unknown): T {
  const b = body as { game?: T } & T;
  return (b.game ?? b) as T;
}
