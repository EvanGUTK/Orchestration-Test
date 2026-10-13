// Performance/fault suite runner (quality-owned; QA-006).
// Discovers tests/performance/scenarios/*.ts (each exports `scenario: Scenario`), runs them sequentially,
// writes one JSON evidence file per scenario to $LAB_RUNTIME/evidence/perf/<scenario>-<timestamp>.json
// (fallback: build/perf-evidence/), and prints a console summary.
// Exit code: 1 ONLY if a correctness check failed or a scenario crashed. Missed performance thresholds are
// reported as "MISSED" and never change the exit code (and are never hidden).
// Usage: npm run test:performance [-- <substring filter> ...]   e.g. `-- ops-02 ops-05`
// Env: PERF_SOAK_MS (OPS-07 duration, default 120000 = smoke), PERF_OPS03_COMMANDS, PERF_OPS02_MOVES.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { environment, REPO_ROOT } from "./lib/report.js";
import type { Scenario, ScenarioResult } from "./lib/report.js";

const dir = fileURLToPath(new URL("./scenarios/", import.meta.url));
const filters = process.argv.slice(2).map((f) => f.toLowerCase());
const files = (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")) : [])
  .sort()
  .filter((f) => filters.length === 0 || filters.some((x) => f.toLowerCase().includes(x)));
if (files.length === 0) {
  console.error(`No performance scenarios matched ${JSON.stringify(filters)}. Nothing was measured.`);
  process.exit(1);
}

const evidenceDir = process.env.LAB_RUNTIME
  ? resolve(process.env.LAB_RUNTIME, "evidence", "perf")
  : resolve(REPO_ROOT, "build", "perf-evidence");
mkdirSync(evidenceDir, { recursive: true });
const env = environment();
console.log(`environment: ${JSON.stringify(env)}`);
console.log(`evidence dir: ${evidenceDir}`);

type Row = { id: string; kind: string; correctness: string; thresholds: string; evidence: string };
const rows: Row[] = [];
let correctnessFailed = false;

for (const file of files) {
  const mod = (await import(pathToFileURL(join(dir, file)).href)) as { scenario?: Scenario };
  const scenario = mod.scenario;
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  let result: ScenarioResult | null = null;
  let crash: string | null = null;
  if (!scenario) crash = `${file} does not export \`scenario\``;
  else {
    console.log(`\n=== ${scenario.id} ${scenario.title} (${file}) ===`);
    try {
      result = await scenario.run();
    } catch (error) {
      crash = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    }
  }
  const id = scenario?.id ?? file;
  const evidence = join(evidenceDir, `${id.toLowerCase()}-${stamp}.json`);
  const record = {
    scenarioFile: `tests/performance/scenarios/${file}`,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: env,
    ...(result ?? {}),
    ...(crash ? { crashed: true, crash } : {}),
  };
  writeFileSync(evidence, JSON.stringify(record, null, 2) + "\n", "utf8");

  const failedChecks = result?.correctness.filter((c) => !c.passed) ?? [];
  if (crash || failedChecks.length > 0) correctnessFailed = true;
  const th = result?.thresholds ?? [];
  rows.push({
    id,
    kind: result?.kind ?? "crashed",
    correctness: crash
      ? "CRASHED"
      : `${(result?.correctness.length ?? 0) - failedChecks.length}/${result?.correctness.length ?? 0} pass`,
    thresholds: th
      .map((t) => `${t.name}=${t.measured}${t.met === null ? " (not judged)" : t.met ? " MET" : " MISSED"}`)
      .join("; "),
    evidence,
  });
  if (crash) console.log(`CRASHED: ${crash.split("\n")[0]}`);
  for (const c of result?.correctness ?? [])
    console.log(`  [${c.passed ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`);
  for (const t of th) {
    const tag = t.met === null ? "n/j" : t.met ? "met" : "MISSED";
    console.log(
      `  [${tag}] ${t.name}: measured ${t.measured} vs target ${t.target}${t.note ? ` (${t.note})` : ""}`,
    );
  }
  for (const n of result?.notMeasured ?? []) console.log(`  [not measured] ${n}`);
  console.log(`  evidence: ${evidence}`);
}

console.log("\n=== summary ===");
for (const r of rows) {
  console.log(
    `${r.id} [${r.kind}] correctness ${r.correctness} | ${r.thresholds || "no thresholds"}\n    ${r.evidence}`,
  );
}
process.exit(correctnessFailed ? 1 : 0);
