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
      //   statements 80.39 | branches 68.88 | functions 95.27 | lines 80.88
      // Set 1-2 points below measured to avoid immediate red while still gating regressions.
      // functions is set nearer the measured 95 to gate regressions on that axis.
      thresholds: {
        statements: 79,
        branches: 67,
        functions: 93,
        lines: 79,
      },
    },
  },
});
