#!/usr/bin/env node
// `npm run dev`: API on 127.0.0.1:$API_PORT and Vite dev server on 127.0.0.1:$WEB_PORT (proxying /api).
import { spawn } from "node:child_process";

const env = { ...process.env, HOST: process.env.HOST ?? "127.0.0.1" };
const children = [
  spawn(process.execPath, ["--watch", "apps/server/src/main.ts"], { env, stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "@2048/web"], { env, stdio: "inherit" }),
];
const stop = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((c) => c.on("exit", (code) => { if (code) { stop(); process.exitCode = code; } }));
