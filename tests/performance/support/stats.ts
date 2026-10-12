import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, platform, arch, release } from "node:os";
import { join } from "node:path";

/** Nearest-rank percentile (documented in every report): p in (0,100], sorted ascending copy. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("no samples");
  const sorted = Float64Array.from(samples).sort();
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarize(samplesMs: readonly number[]) {
  const sum = samplesMs.reduce((a, b) => a + b, 0);
  return {
    count: samplesMs.length,
    meanMs: sum / samplesMs.length,
    p50Ms: percentile(samplesMs, 50),
    p95Ms: percentile(samplesMs, 95),
    p99Ms: percentile(samplesMs, 99),
    maxMs: percentile(samplesMs, 100),
  };
}

export function hostInfo() {
  const c = cpus();
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: c[0]?.model ?? "unknown",
    cpuCount: c.length,
    totalMemBytes: totalmem(),
    node: process.version,
  };
}

export const PERCENTILE_METHOD = "nearest-rank on ascending-sorted samples: value at index ceil(p/100*n)-1";

/** Reports go under $LAB_RUNTIME/perf (ignored runtime area) or ./.lab/perf; never into tracked files. */
export function writeReport(name: string, body: Record<string, unknown>): string {
  const dir = join(process.env.LAB_RUNTIME ?? join(process.cwd(), ".lab"), "perf");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  const report = { name, finishedAt: new Date().toISOString(), host: hostInfo(), percentileMethod: PERCENTILE_METHOD, ...body };
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

export function hr(): bigint {
  return process.hrtime.bigint();
}
export function ms(from: bigint, to: bigint): number {
  return Number(to - from) / 1e6;
}
