// M0 skeleton created by chief; owned by the quality lane from CONTRACT-001 onward.
import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT ?? "5612";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // No retries: a flaky test must be reported, never hidden. Each test gets a fresh browser context
  // (empty localStorage) against one shared server whose database is private to this run.
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Production build served by the loopback server against a private throwaway database.
    command: "node apps/server/dist/main.js",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/api/v1/health`,
    reuseExistingServer: false,
    env: {
      HOST: "127.0.0.1",
      API_PORT: port,
      DATA_DIR: "build/e2e-data",
      DATABASE_PATH: `build/e2e-data/e2e-${Date.now()}.sqlite3`,
    },
  },
});
