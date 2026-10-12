/** Location of the bot worker entry for source (tests/dev via tsx) and built (dist) layouts. */
const SOURCE_MODE = import.meta.url.endsWith(".ts");

export const WORKER_URL = new URL(SOURCE_MODE ? "./bot-worker.ts" : "./bot-worker.js", import.meta.url);

// Source checkouts load the TypeScript worker through tsx with the workspace "source" export
// condition; built output runs the compiled worker directly.
export const WORKER_EXEC_ARGV: string[] = SOURCE_MODE ? ["--conditions=source", "--import", "tsx"] : [];
