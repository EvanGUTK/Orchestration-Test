import { defineConfig } from "@playwright/test";

// Quality owns this file. Placeholder config so `npm run test:e2e` resolves; real specs land with QUALITY-001.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  use: { baseURL: `http://127.0.0.1:${process.env.WEB_PORT ?? "5411"}` },
});
