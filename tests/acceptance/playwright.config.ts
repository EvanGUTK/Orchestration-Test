import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Quality owns this file. Production bundle served by the production server entry on loopback, private temp DB.
// Prerequisite: `npm run build` (the server serves apps/web/dist). E2E_PORT defaults to 5611 (distinct from
// WEB_PORT/API_PORT so the e2e run never collides with the chief's integration checkout).
const port = Number(process.env.E2E_PORT ?? 5611);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "en-US",
    // Optional: point at an already-installed Chromium when `npx playwright install` has not been run for 1.64.
    ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // Responsive projects only re-run the browser-shell specs; API specs run once (desktop).
    { name: "tablet", testMatch: /shell-.*\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: "mobile-320", testMatch: /shell-.*\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    command: "node tests/acceptance/support/boot-server.ts",
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
