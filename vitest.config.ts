import { defineConfig } from "vitest/config";

// Workspace packages export `source` -> src/*.ts, so tests run against sources without a build.
export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "apps/server/src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**", "**/dist/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "acceptance",
          environment: "node",
          include: ["tests/acceptance/**/*.test.ts"],
          exclude: ["tests/acceptance/e2e/**", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: [
            "tests/integration/**/*.test.ts",
            "packages/*/src/**/*.int.test.ts",
            "apps/server/src/**/*.int.test.ts",
          ],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
