// M0 skeleton created by chief; owned by the quality lane from CONTRACT-001 onward.
// Discovers tests/performance/scenarios/*.ts; each exports `run(): Promise<ScenarioResult>`.
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = fileURLToPath(new URL("./scenarios/", import.meta.url));
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")) : [];
if (files.length === 0) {
  console.error(
    "No performance scenarios implemented yet (OPS-02..OPS-10 are M6 work). Nothing was measured.",
  );
  process.exit(1);
}
for (const file of files) {
  const scenario = (await import(pathToFileURL(dir + file).href)) as { run: () => Promise<unknown> };
  console.log(JSON.stringify({ scenario: file, result: await scenario.run() }));
}
