/**
 * Playwright `webServer` command: boots the production server on a fixed loopback test port with a private
 * temp database, stays alive until SIGTERM/SIGINT, then removes the temp data. Never uses $DATABASE_PATH.
 */
import { startServer } from "./server-process.ts";

const port = Number(process.env.E2E_PORT ?? 5611);
const server = await startServer({ port, timeoutMs: 60_000 });
console.log(`e2e server ready on ${server.baseUrl} db=${server.dbPath}`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.child().on("exit", (code) => {
  console.error(`server exited unexpectedly (${code})\n${server.logs()}`);
  process.exit(1);
});
setInterval(() => {}, 1 << 30);
