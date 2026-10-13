// Shared result schema + statistics for tests/performance scenarios (QA-006).
// Percentiles use the NEAREST-RANK method: sort ascending, rank = ceil(p/100 * n), value = sorted[rank-1].
import { execFileSync } from "node:child_process";
import { cpus, freemem, totalmem, platform, release, type as osType, arch } from "node:os";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const PERCENTILE_METHOD =
  "nearest-rank (sorted ascending; rank = ceil(p/100*n); value = sorted[rank-1])";

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export type Summary = {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  unit: string;
};

export function summarize(samples: readonly number[], unit = "ms"): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((s, x) => s + x, 0) / (sorted.length || 1);
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    count: sorted.length,
    min: r(sorted[0] ?? Number.NaN),
    p50: r(percentile(sorted, 50)),
    p95: r(percentile(sorted, 95)),
    p99: r(percentile(sorted, 99)),
    max: r(sorted.at(-1) ?? Number.NaN),
    mean: r(mean),
    unit,
  };
}

export type Threshold = {
  name: string;
  target: string;
  measured: number | string | null;
  /** null = not judged (e.g. smoke run or not measurable here) */
  met: boolean | null;
  note?: string;
};

export type Check = { name: string; passed: boolean; detail: string };

export type ScenarioResult = {
  id: string; // e.g. "OPS-02"
  title: string;
  /** "result" = the acceptance measurement; "smoke" = short indicative run; "partial" = part of the row */
  kind: "result" | "smoke" | "partial";
  dataset: string;
  warmup: string;
  rawSampleCount: number;
  percentileMethod: string;
  metrics: Record<string, unknown>;
  thresholds: Threshold[];
  correctness: Check[];
  notMeasured: string[];
  notes: string[];
};

export type Scenario = {
  id: string;
  title: string;
  run: () => Promise<ScenarioResult>;
};

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function environment(): Record<string, unknown> {
  const c = cpus();
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  return {
    os: { type: osType(), platform: platform(), release: release(), arch: arch() },
    cpu: { model: c[0]?.model ?? "unknown", logicalCores: c.length, speedMHz: c[0]?.speed ?? null },
    ramBytes: { total: totalmem(), freeAtStart: freemem() },
    node: process.version,
    gitSha: git(["rev-parse", "HEAD"]),
    gitDirtyTrackedFiles: dirty === "" ? false : dirty === "unknown" ? "unknown" : true,
    gitBranch: git(["branch", "--show-current"]),
    labExperiment: process.env.LAB_EXPERIMENT ?? null,
    labRunId: process.env.LAB_RUN_ID ?? null,
  };
}

export function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

export function threshold(
  name: string,
  target: string,
  measured: number | null,
  met: boolean | null,
  note?: string,
): Threshold {
  return { name, target, measured, met, ...(note ? { note } : {}) };
}

/** Deterministic PRNG for workload choices (mulberry32); never used for game randomness. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
