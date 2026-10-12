import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      ".lab/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      // Exact values: never route tile/score values through floating point parsing.
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Exact values use BigInt/decimal strings." },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["packages/engine/src/**/*.ts"],
    ignores: ["packages/engine/src/**/*.test.ts"],
    rules: {
      // The engine is pure: no clocks, randomness, I/O, or browser globals.
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Exact values use BigInt/decimal strings." },
        { name: "window", message: "Engine is pure." },
        { name: "document", message: "Engine is pure." },
        { name: "fetch", message: "Engine is pure." },
        { name: "localStorage", message: "Engine is pure." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the versioned PRNG." },
        { object: "Date", property: "now", message: "Engine is clock-free." },
      ],
      "no-restricted-imports": ["error", { patterns: ["node:*", "fs", "path", "http", "crypto"] }],
    },
  },
);
