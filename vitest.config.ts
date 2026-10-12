import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "performance",
          include: ["tests/performance/**/*.perf.ts"],
          testTimeout: 600_000,
        },
      },
    ],
  },
});
