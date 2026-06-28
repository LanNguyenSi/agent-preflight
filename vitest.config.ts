import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000, // integration tests with lint/audit checks can take >5s on CI
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Thresholds ratcheted to current measured actuals (2026-06-28 baseline):
      //   statements 76.25 | branches 61.69 | functions 89.25 | lines 76.27
      // Set 1-2 points below measured to avoid immediate red while still gating regressions.
      thresholds: {
        statements: 75,
        branches: 60,
        functions: 88,
        lines: 75,
      },
    },
  },
});
