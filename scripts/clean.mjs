// Removes build outputs only (never databases or runtime data).
import { rmSync } from "node:fs";

const targets = ["build", "apps/web/dist", "apps/web/build", "apps/server/dist"];
for (const pkg of ["contracts", "engine", "database", "bots", "competition"])
  targets.push(`packages/${pkg}/dist`);
for (const target of targets) rmSync(target, { recursive: true, force: true });
console.log(`Removed: ${targets.join(", ")}`);
