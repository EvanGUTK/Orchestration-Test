// Differential fuzzing (ENG-08/ENG-10 support): ~200 random seeds/direction sequences run through
// the TS engine and the independent Python oracle (tests/acceptance/oracle/oracle_cli.py) must give
// identical per-step checksums, rng words, score deltas, change flags, and EngineError codes.
// Reproducible: fast-check fixed seed. Python is REQUIRED (no silent skip); set $PYTHON to override.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DIRECTIONS, RULESETS, practiceRuleset } from "@g2048/contracts";
import type { Direction, GameState, Ruleset } from "@g2048/contracts";
import { E } from "./engine-api.js";
import type { EngineErrorLike } from "./engine-api.js";
import { frozen } from "./helpers.js";

const FC_SEED = 20261012;
const CASES = 200;
const ORACLE_CLI = fileURLToPath(new URL("../oracle/oracle_cli.py", import.meta.url));

type FuzzCase = {
  id: number;
  seed: string;
  size: number;
  fourWeight: number;
  rulesetVersion: string;
  moveCap: number | null;
  directions: Direction[];
};
type OracleStep = {
  direction: Direction;
  changed: boolean;
  scoreDelta: string;
  checksum: string;
  rngWords: number[];
  status: string;
  error: string | null;
};
type OracleResult = {
  id: number;
  initial: { checksum: string; canonicalJson: string };
  steps: OracleStep[];
  final: { checksum: string; canonicalJson: string };
};

function findPython(): string {
  const candidates = [process.env.PYTHON, "python3", "python", "py"].filter((c): c is string => !!c);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return c;
  }
  throw new Error(`Python 3 not found (tried ${candidates.join(", ")}); the oracle is required, set $PYTHON`);
}

function runOracle(cases: FuzzCase[]): OracleResult[] {
  const r = spawnSync(findPython(), [ORACLE_CLI], {
    input: JSON.stringify({ cases }),
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  if (r.status !== 0) throw new Error(`oracle failed (${r.status}): ${r.stderr}`);
  return (JSON.parse(r.stdout) as { results: OracleResult[] }).results;
}

function rulesOf(c: FuzzCase): Ruleset {
  if (c.rulesetVersion === "practice-v1")
    return practiceRuleset({ size: c.size, fourWeight: c.fourWeight, undo: true });
  const r = (RULESETS as Record<string, Ruleset>)[c.rulesetVersion];
  if (!r) throw new Error(c.rulesetVersion);
  return r;
}

const caseArb = fc
  .record({
    seed: fc.string({ unit: "grapheme", minLength: 1, maxLength: 24 }),
    kind: fc.constantFrom("classic-v1", "ranked-v1", "practice-v1", "practice-v1"),
    size: fc.integer({ min: 3, max: 8 }),
    fourWeight: fc.integer({ min: 0, max: 10 }),
    directions: fc.array(fc.constantFrom<Direction>(...DIRECTIONS), {
      minLength: 20,
      maxLength: 120,
      size: "max",
    }),
  })
  .map(({ seed, kind, size, fourWeight, directions }) => {
    const builtin = kind === "practice-v1" ? null : (RULESETS as Record<string, Ruleset>)[kind];
    return {
      seed,
      size: builtin ? builtin.size : size,
      fourWeight: builtin ? builtin.fourWeight : fourWeight,
      rulesetVersion: kind,
      // ranked-v1's frozen cap (500) is not reached by these short sequences; ENG-07 covers the cap.
      moveCap: builtin ? builtin.moveCap : null,
      directions,
    };
  });

function buildCases(): FuzzCase[] {
  const sampled = fc.sample(caseArb, { seed: FC_SEED, numRuns: CASES });
  return sampled.map((c, id) => ({ id, ...c }));
}

type TsStep = Omit<OracleStep, "status"> & { status: string };

function runEngine(c: FuzzCase): { initial: string; steps: TsStep[]; finalJson: string } {
  const rules = rulesOf(c);
  let state: GameState = frozen(E.newGame(rules, c.seed));
  const initial = E.checksum(state);
  const steps: TsStep[] = [];
  for (const d of c.directions) {
    try {
      const res = E.applyMove(state, d, rules);
      state = frozen(res.state);
      steps.push({
        direction: d,
        changed: res.changed,
        scoreDelta: res.scoreDelta,
        checksum: E.checksum(state),
        rngWords: [...state.rng.words],
        status: state.status,
        error: null,
      });
    } catch (error) {
      if (!(error instanceof E.EngineError)) throw error;
      steps.push({
        direction: d,
        changed: false,
        scoreDelta: "0",
        checksum: E.checksum(state),
        rngWords: [...state.rng.words],
        status: state.status,
        error: (error as EngineErrorLike).code,
      });
    }
  }
  return { initial, steps, finalJson: E.canonicalJson(state) };
}

describe("DIFF-ENGINE differential fuzzing: TS engine vs independent Python oracle", () => {
  const cases = buildCases();

  it("case generation is reproducible (fixed fast-check seed)", () => {
    expect(buildCases()).toEqual(cases);
    expect(cases).toHaveLength(CASES);
    expect(new Set(cases.map((c) => c.rulesetVersion))).toEqual(
      new Set(["classic-v1", "ranked-v1", "practice-v1"]),
    );
  });

  it(
    `${CASES} cases produce identical per-step checksums, rng words, deltas and errors`,
    { timeout: 120_000 },
    () => {
      const oracle = runOracle(cases);
      expect(oracle).toHaveLength(cases.length);
      let steps = 0;
      for (const c of cases) {
        const o = oracle[c.id];
        if (!o) throw new Error(`oracle result missing for case ${c.id}`);
        const ts = runEngine(c);
        const repro = `case ${c.id} ${JSON.stringify(c)}`;
        expect(ts.initial, `initial checksum, ${repro}`).toBe(o.initial.checksum);
        for (let i = 0; i < c.directions.length; i++) {
          const a = ts.steps[i];
          const b = o.steps[i];
          expect(a, `step ${i}, ${repro}`).toEqual(b);
          steps++;
        }
        expect(ts.finalJson, repro).toBe(o.final.canonicalJson);
      }
      expect(steps).toBeGreaterThan(CASES * 20);
    },
  );
});
