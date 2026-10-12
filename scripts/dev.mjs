// Runs the loopback API (watch mode, sources via the "source" export condition) and the Vite dev server.
import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["--conditions=source", "--import", "tsx", "--watch", "apps/server/src/main.ts"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "apps/web"], { stdio: "inherit" }),
];
const stop = () => children.forEach((child) => child.kill());
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children)
  child.on("exit", (code) => code && process.exitCode === undefined && (process.exitCode = code));
