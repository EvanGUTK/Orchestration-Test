/**
 * The system under test for pure-engine workloads. `@2048/engine` is loaded dynamically so this file
 * type-checks before the engine exists. PERF_SUBJECT=oracle runs the harness against the independent
 * quality oracle (harness self-check only; never a substitute for an engine result).
 */
import { applyMove as oApply, legalMoves as oLegal, newGame as oNew, checksum as oChecksum, type Dir, type ORules, type OState } from "../../integration/oracle/game.ts";

export type SubjectState = { status: string; board: { size: number; cells: readonly (string | null)[] }; score: string; acceptedMoves: number; revision: number };
export type Subject = {
  name: string;
  newGame(rules: ORules, seed: string): SubjectState;
  applyMove(state: SubjectState, dir: Dir, rules: ORules): { state: SubjectState; changed: boolean };
  legalMoves(board: SubjectState["board"]): Dir[];
  checksum(state: SubjectState): string;
};

const oracleSubject: Subject = {
  name: "oracle",
  newGame: (r, s) => oNew(r, s).state,
  applyMove: (st, d, r) => oApply(st as OState, d, r),
  legalMoves: (b) => oLegal(b.cells as (string | null)[], b.size),
  checksum: (st) => oChecksum(st as OState),
};

export async function loadSubject(): Promise<Subject | null> {
  if (process.env.PERF_SUBJECT === "oracle") return oracleSubject;
  const spec = "@2048/engine";
  try {
    const eng = (await import(/* @vite-ignore */ spec)) as {
      newGame: (rules: unknown, seed: string) => SubjectState;
      applyMove: (s: SubjectState, d: Dir, rules: unknown) => { state: SubjectState; changed: boolean };
      legalMoves: (b: SubjectState["board"]) => Dir[];
      stateChecksum: (s: SubjectState) => string;
    };
    if (typeof eng.applyMove !== "function") return null;
    return {
      name: "@2048/engine",
      newGame: (r, s) => eng.newGame(r, s),
      applyMove: (st, d, r) => eng.applyMove(st, d, r),
      legalMoves: (b) => eng.legalMoves(b),
      checksum: (st) => eng.stateChecksum(st),
    };
  } catch {
    return null;
  }
}
